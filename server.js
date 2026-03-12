const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

axios.defaults.timeout = 5000;

/* ---------------- CONFIG ---------------- */
const ABTYP_HEADERS = {
  "api-Key": "ABTYP_API_SECRET_KEY_@ABTYP2023#@763^%ggjhg%",
  "Content-Type": "application/json"
};

const PHONE_NUMBER_ID = "908875015643505";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PRIVATE_KEY = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, "\n") : null;

if (!PRIVATE_KEY) {
    console.error("❌ CRITICAL ERROR: PRIVATE_KEY environment variable is missing!");
}

/* ---------------- HELPERS ---------------- */
const mapList = (arr) => (arr || []).map((item) => ({
    id: item.Id?.toString() || "",
    title: item.Name || ""
}));

const encryptResponse = (data, aesKey, iv) => {
  const invertedIv = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) {
    invertedIv[i] = ~iv[i];
  }
  const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, invertedIv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64");
};

/* ---------------- ROUTES ---------------- */

app.get("/", (req, res) => {
  res.status(200).send("ABTYP Flow Server is Active");
});

app.post("/", async (req, res) => {
  console.log("\n--- New POST Request Received ---");
  
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = req.body;

  if (!encrypted_aes_key) {
    return res.status(200).json({ status: "active" });
  }

  let aesKey, requestIv, decryptedPayload;

  try {
    /* STEP 1: RSA DECRYPTION */
    aesKey = crypto.privateDecrypt(
      {
        key: PRIVATE_KEY,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
        mgf1Hash: "sha256", 
      },
      Buffer.from(encrypted_aes_key, "base64")
    );

    /* STEP 2: AES DECRYPTION */
    const flowBuffer = Buffer.from(encrypted_flow_data, "base64");
    requestIv = Buffer.from(initial_vector, "base64");

    const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);
    decipher.setAuthTag(flowBuffer.slice(-16));

    const decrypted = Buffer.concat([
      decipher.update(flowBuffer.slice(0, -16)),
      decipher.final()
    ]).toString("utf8");

    decryptedPayload = JSON.parse(decrypted);
    console.log(`✅ Decrypted Action: ${decryptedPayload.action}`);

    /* STEP 3: LOGIC HANDLING */
    const { action, data } = decryptedPayload;
    
    // Meta requires ping-pong to verify endpoint health
    if (action === "ping") {
      return res.status(200).send(
        encryptResponse({ version: "7.1", data: { status: "active" } }, aesKey, requestIv)
      );
    }

    if (action === "INIT" || action === "data_exchange") {
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

      // 1. Fetch Countries (Always)
      const cRes = await axios.get("https://api.abtyp.org/v0/country", { headers: ABTYP_HEADERS });
      resp.data.country_list = mapList(cRes.data?.Data);

      // 2. Conditional State Fetching
      if (data?.country_id) {
        const sRes = await axios.get(`https://api.abtyp.org/v0/state?CountryId=${data.country_id}`, { headers: ABTYP_HEADERS });
        resp.data.state_list = mapList(sRes.data?.Data);
        resp.data.is_state_enabled = resp.data.state_list.length > 0;
      }

      // 3. Conditional Parishad Fetching
      if (data?.state_id) {
        const pRes = await axios.get(`https://api.abtyp.org/v0/parishad?StateId=${data.state_id}`, { headers: ABTYP_HEADERS });
        resp.data.parishad_list = mapList(pRes.data?.Data);
        resp.data.is_parishad_enabled = resp.data.parishad_list.length > 0;
      }

      // 4. Final Selection Logic
      if (data?.parishad_id) {
        resp.data.status_text = "Selection Received. Click Submit to finish.";
        resp.data.is_submit_enabled = true;
      }

      return res.status(200).send(encryptResponse(resp, aesKey, requestIv));
    }

   if (action === "complete") {
    // 1. Try to get it from flow_context
    // 2. Try to get it from a field you might have passed from the first screen
    // 3. Fallback to a log to see what Meta actually sent
    const senderNumber = decryptedPayload.flow_context?.sender_id || data?.phone_number;

    console.log(`Step 3: Flow Completed by ${senderNumber}. Data:`, data);

    if (senderNumber && data?.parishad_id) {
        sendWhatsAppLink(data.parishad_id, senderNumber);
    }

    return res.status(200).send(encryptResponse({ 
        version: "7.1", 
        data: { acknowledged: true } 
    }, aesKey, requestIv));
}

  } catch (err) {
    console.error("🔴 ERROR:", err.message);
    if (aesKey && requestIv) {
      return res.status(200).send(encryptResponse({ version: "7.1", error: "flow_error", details: err.message }, aesKey, requestIv));
    }
    return res.status(500).json({ error: "internal_server_error" });
  }
});

/* ---------------- BACKGROUND SENDER ---------------- */

async function sendWhatsAppLink(parishadId, to) {
    try {
        console.log(`[Background] Fetching link for Parishad: ${parishadId}`);
        const linkRes = await axios.get(`https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${parishadId}`, { headers: ABTYP_HEADERS });
        
        const link = linkRes.data?.Data?.WhatsAppGroupLink;
        if (!link) {
            console.error(`[Background] No link found in API response for ID: ${parishadId}`);
            return;
        }

        console.log(`[Background] Sending Meta Request to: ${to}`);
        const metaRes = await axios.post(`https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp",
            to: to,
            type: "text",
            text: { body: `Welcome to ABTYP 🙏\n\nYour Link:\n${link}` }
        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });

        console.log(`[Background] Meta API Success:`, metaRes.data);
    } catch (e) {
        // This will tell you EXACTLY why Meta rejected the message
        console.error("[Background] Error Details:", e.response?.data || e.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 ABTYP Server Live on Port ${PORT}`);
});
