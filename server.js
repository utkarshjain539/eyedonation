const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

axios.defaults.timeout = 5000; // Increased slightly for sequential API calls

/* ---------------- CONFIG ---------------- */

const ABTYP_HEADERS = {
  "api-Key": "ABTYP_API_SECRET_KEY_@ABTYP2023#@763^%ggjhg%",
  "Content-Type": "application/json"
};

const PHONE_NUMBER_ID = "1049088024951885";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PRIVATE_KEY = process.env.PRIVATE_KEY.replace(/\\n/g, "\n");

/* ---------------- HELPERS ---------------- */

const mapList = (arr) =>
  (arr || []).map((item) => ({
    id: item.Id?.toString() || "",
    title: item.Name || ""
  }));

const encryptResponse = (data, aesKey, iv) => {
  const invertedIv = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) {
    invertedIv[i] = ~iv[i];
  }

  const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, invertedIv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(data), "utf8"),
    cipher.final()
  ]);

  return Buffer.concat([
    encrypted,
    cipher.getAuthTag()
  ]).toString("base64");
};

/* ---------------- SERVER TEST / HEALTH CHECK ---------------- */

// Handles GET requests from Meta or browsers
app.get("/", (req, res) => {
  res.status(200).send("ABTYP WhatsApp Flow Server is Active");
});

/* ---------------- FLOW ENDPOINT ---------------- */

app.post("/", async (req, res) => {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = req.body;

  // HEALTH CHECK: Meta often sends a POST without these fields to verify endpoint
  if (!encrypted_aes_key || !encrypted_flow_data || !initial_vector) {
    console.log("Health check or empty payload received.");
    return res.status(200).json({ status: "active" });
  }

  let aesKey;
  let requestIv;

  try {
    /* 1. DECRYPT AES KEY (RSA-OAEP-256) */
    aesKey = crypto.privateDecrypt(
      {
        key: PRIVATE_KEY,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
        mgf1Hash: "sha256", // Critical for Meta compatibility
      },
      Buffer.from(encrypted_aes_key, "base64")
    );

    /* 2. DECRYPT FLOW PAYLOAD (AES-GCM-128) */
    const flowBuffer = Buffer.from(encrypted_flow_data, "base64");
    requestIv = Buffer.from(initial_vector, "base64");

    const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);
    decipher.setAuthTag(flowBuffer.slice(-16));

    const decrypted = Buffer.concat([
      decipher.update(flowBuffer.slice(0, -16)),
      decipher.final()
    ]).toString("utf8");

    const payload = JSON.parse(decrypted);
    const { action, data } = payload;
    
    // Determine sender number for the final message
    const senderNumber = payload.flow_context?.sender_id || payload.user_id || "919327447138";

    console.log(`Action: ${action} | Received IDs: Country:${data?.country_id}, State:${data?.state_id}`);

    /* ---------------- FLOW LOGIC ---------------- */

    if (action === "INIT" || action === "data_exchange") {
      
      // Initialize response structure
      let resp = {
        version: "7.1",
        screen: "LOCATION_SCREEN",
        data: {
          country_list: [],
          state_list: [],
          parishad_list: [],
          is_state_enabled: false,
          is_parishad_enabled: false,
          status_text: "",
          is_submit_enabled: false
        }
      };

      // FETCH COUNTRIES: Always needed for the first dropdown
      const cRes = await axios.get("https://api.abtyp.org/v0/country", { headers: ABTYP_HEADERS });
      resp.data.country_list = mapList(cRes.data?.Data);

      // FETCH STATES: If country is selected
      if (data?.country_id) {
        const sRes = await axios.get(
          `https://api.abtyp.org/v0/state?CountryId=${data.country_id}`,
          { headers: ABTYP_HEADERS }
        );
        resp.data.state_list = mapList(sRes.data?.Data);
        resp.data.is_state_enabled = resp.data.state_list.length > 0;
      }

      // FETCH PARISHADS: If state is selected
      if (data?.state_id) {
        const pRes = await axios.get(
          `https://api.abtyp.org/v0/parishad?StateId=${data.state_id}`,
          { headers: ABTYP_HEADERS }
        );
        resp.data.parishad_list = mapList(pRes.data?.Data);
        resp.data.is_parishad_enabled = resp.data.parishad_list.length > 0;
      }

      // FINAL SELECTION: If parishad is selected
      if (data?.parishad_id) {
        resp.data.status_text = "✅ Ready! Click Finish to receive the link.";
        resp.data.is_submit_enabled = true;
        
        // Trigger background message sending
        sendWhatsAppLink(data.parishad_id, senderNumber);
      }

      return res.status(200).send(encryptResponse(resp, aesKey, requestIv));
    }

    if (action === "complete") {
      return res.status(200).send(
        encryptResponse({ data: { acknowledged: true } }, aesKey, requestIv)
      );
    }

  } catch (err) {
    console.error("FLOW ERROR:", err.message);
    
    // Return an encrypted error if keys are available, otherwise plain JSON
    if (aesKey && requestIv) {
      return res.status(200).send(
        encryptResponse({ error: "flow_error", message: err.message }, aesKey, requestIv)
      );
    }
    return res.status(200).json({ error: "decryption_failed" });
  }
});

/* ---------------- ASYNC WHATSAPP SENDER ---------------- */

async function sendWhatsAppLink(parishadId, to) {
  try {
    const linkRes = await axios.get(
      `https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${parishadId}`,
      { headers: ABTYP_HEADERS }
    );

    const link = linkRes.data?.Data?.WhatsAppGroupLink;

    if (link) {
      await axios.post(
        `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          to: to,
          type: "text",
          text: { body: `Welcome to ABTYP 🙏\n\nYour Parishad WhatsApp Group Link:\n${link}` }
        },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
      );
      console.log("Link successfully sent to", to);
    }
  } catch (err) {
    console.error("WhatsApp Link Sender Error:", err.message);
  }
}

/* ---------------- START SERVER ---------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("ABTYP Flow Server running on port", PORT);
});
