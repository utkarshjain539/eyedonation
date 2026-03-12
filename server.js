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

// Memory Cache for Countries
let cachedCountries = null;

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
    const { action, data } = decryptedPayload;
    const senderId = decryptedPayload.flow_context?.sender_id;

    console.log(`\n📱 ACTION: ${action} | SENDER: ${senderId || 'Testing'}`);

    /* STEP 3: LOGIC HANDLING */
    
    // 1. Meta Health Check
    if (action === "ping") {
      return res.status(200).send(
        encryptResponse({ version: "7.1", data: { status: "active" } }, aesKey, requestIv)
      );
    }

    // 2. Selection Logic (Dropdowns)
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

      // Fetch Countries (Cached)
      if (!cachedCountries) {
        const cRes = await axios.get("https://api.abtyp.org/v0/country", { headers: ABTYP_HEADERS });
        cachedCountries = mapList(cRes.data?.Data);
      }
      resp.data.country_list = cachedCountries;

      // Fetch States
      if (data?.country_id) {
        const sRes = await axios.get(`https://api.abtyp.org/v0/state?CountryId=${data.country_id}`, { headers: ABTYP_HEADERS });
        resp.data.state_list = mapList(sRes.data?.Data);
        resp.data.is_state_enabled = resp.data.state_list.length > 0;
      }

      // Fetch Parishads
      if (data?.state_id) {
        const pRes = await axios.get(`https://api.abtyp.org/v0/parishad?StateId=${data.state_id}`, { headers: ABTYP_HEADERS });
        resp.data.parishad_list = mapList(pRes.data?.Data);
        resp.data.is_parishad_enabled = resp.data.parishad_list.length > 0;
      }

      // Parishad Selected? Enable Finish
      if (data?.parishad_id) {
        resp.data.status_text = "✅ Selection complete. Click Finish to receive your link.";
        resp.data.is_submit_enabled = true;
      }

      return res.status(200).send(encryptResponse(resp, aesKey, requestIv));
    }

    // 3. Final Submission
 if (action === "complete") {
      console.log("-----------------------------------------");
      console.log("🏁 COMPLETE ACTION TRIGGERED");
      console.log("DATA RECEIVED:", JSON.stringify(data));
      console.log("FLOW CONTEXT:", JSON.stringify(decryptedPayload.flow_context));
      
      const parishadId = data?.parishad_id;
      
      // Attempt to get the number from multiple sources
      let senderNumber = decryptedPayload.flow_context?.sender_id;
      
      // FALLBACK: If Meta is sending "Testing" or null, we need to know
      if (!senderNumber || senderNumber === "Testing") {
          console.log("⚠️ Meta didn't provide a real Sender ID. Using fallback for debug.");
          senderNumber = "919327447138"; // Replace with your number for final verification
      }

      if (parishadId) {
        console.log(`🚀 Triggering background API call for Parishad: ${parishadId} to ${senderNumber}`);
        sendWhatsAppLink(parishadId, senderNumber);
      } else {
        console.error("❌ CRITICAL: 'parishad_id' was missing from the final submission payload.");
      }

      return res.status(200).send(encryptResponse({ 
        version: "7.1", 
        data: { acknowledged: true } 
      }, aesKey, requestIv));
    }

  } catch (err) {
    console.error("🔴 SERVER ERROR:", err.message);
    if (aesKey && requestIv) {
      return res.status(200).send(encryptResponse({ version: "7.1", error: "flow_error" }, aesKey, requestIv));
    }
    return res.status(500).json({ error: "decryption_failed" });
  }
});

/* ---------------- BACKGROUND SENDER ---------------- */

async function sendWhatsAppLink(parishadId, to) {
    try {
        console.log(`[Async] Requesting Link for Parishad: ${parishadId}`);
        const linkRes = await axios.get(`https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${parishadId}`, { headers: ABTYP_HEADERS });
        
        const link = linkRes.data?.Data?.WhatsAppGroupLink;

        if (link) {
            console.log(`[Async] Sending WhatsApp message to: ${to}`);
            await axios.post(`https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`, {
                messaging_product: "whatsapp",
                to: to,
                type: "text",
                text: { body: `Welcome to ABTYP 🙏\n\nYour Parishad WhatsApp Group Link:\n${link}` }
            }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
            console.log(`✅ SUCCESS: Link sent to ${to}`);
        } else {
            console.error(`[Async] ❌ No link found for Parishad ID: ${parishadId}`);
        }
    } catch (e) {
        console.error("[Async] ❌ ERROR sending message:");
        console.error(e.response?.data || e.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 ABTYP Flow Server Live on Port ${PORT}`);
});
