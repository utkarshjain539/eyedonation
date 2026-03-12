const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json());

/* ---------------- CONFIG ---------------- */
const ABTYP_HEADERS = {
  "api-Key": "ABTYP_API_SECRET_KEY_@ABTYP2023#@763^%ggjhg%",
  "Content-Type": "application/json"
};

const PHONE_NUMBER_ID = "908875015643505";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PRIVATE_KEY = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, "\n") : null;

let cachedCountries = null;

/* ---------------- HELPERS ---------------- */
const mapList = (arr) => (arr || []).map((item) => ({
    id: item.Id?.toString() || "",
    title: item.Name || ""
}));

const encryptResponse = (data, aesKey, iv) => {
  const invertedIv = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) { invertedIv[i] = ~iv[i]; }
  const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, invertedIv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64");
};

/* ---------------- MAIN ROUTE ---------------- */

app.post("/", async (req, res) => {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = req.body;
  if (!encrypted_aes_key) return res.status(200).json({ status: "active" });

  let aesKey, requestIv, decryptedPayload;

  try {
    // 1. Decrypt Data
    aesKey = crypto.privateDecrypt(
      { key: PRIVATE_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", mgf1Hash: "sha256" },
      Buffer.from(encrypted_aes_key, "base64")
    );

    const flowBuffer = Buffer.from(encrypted_flow_data, "base64");
    requestIv = Buffer.from(initial_vector, "base64");
    const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);
    decipher.setAuthTag(flowBuffer.slice(-16));
    const decrypted = Buffer.concat([decipher.update(flowBuffer.slice(0, -16)), decipher.final()]).toString("utf8");
    decryptedPayload = JSON.parse(decrypted);

    const { action, data } = decryptedPayload;
    
    // CAPTURE SENDER: Try flow_context (Live) or data.phone_number (Testing/Manual)
    const senderNumber = decryptedPayload.flow_context?.sender_id || data?.phone_number;

    console.log(`\n--- Action: ${action} | User: ${senderNumber} ---`);

    // 2. Handle Data Selection (Dropdowns)
    if (action === "INIT" || action === "data_exchange") {
      let resp = {
        version: "7.1",
        screen: "LOCATION_SCREEN",
        data: {
          phone_number: senderNumber, // Crucial: Keep passing the number through
          country_list: [],
          state_list: [],
          parishad_list: [],
          is_state_enabled: false,
          is_parishad_enabled: false,
          is_submit_enabled: false
        }
      };

      // Fetch Countries
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

      // If Parishad is selected, allow user to click Submit
      if (data?.parishad_id) {
        resp.data.is_submit_enabled = true;
      }

      return res.status(200).send(encryptResponse(resp, aesKey, requestIv));
    }

    // 3. Handle Final Submission
    if (action === "complete") {
      console.log(`✅ User ${senderNumber} submitted Parishad ID: ${data.parishad_id}`);

      // Run this in background so the Flow closes immediately on the user's phone
      if (senderNumber && data.parishad_id) {
        sendWhatsAppLink(data.parishad_id, senderNumber);
      }

      return res.status(200).send(encryptResponse({ 
        version: "7.1", 
        data: { acknowledged: true } 
      }, aesKey, requestIv));
    }

  } catch (err) {
    console.error("🔴 Error:", err.message);
    return res.status(500).json({ error: "internal_error" });
  }
});

/* ---------------- BACKGROUND SENDER ---------------- */

async function sendWhatsAppLink(parishadId, to) {
    try {
        console.log(`[API] Fetching link for Parishad: ${parishadId}`);
        const linkRes = await axios.get(`https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${parishadId}`, { headers: ABTYP_HEADERS });
        
        const link = linkRes.data?.Data?.WhatsAppGroupLink;

        if (link) {
            console.log(`[WhatsApp] Sending link to ${to}`);
            await axios.post(`https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`, {
                messaging_product: "whatsapp",
                to: to,
                type: "text",
                text: { body: `Welcome to ABTYP 🙏\n\nHere is your Parishad WhatsApp Group Link:\n${link}` }
            }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
            console.log(`🚀 Successfully sent link to user.`);
        } else {
            console.warn(`⚠️ No link found in ABTYP API for Parishad ID: ${parishadId}`);
        }
    } catch (e) {
        console.error("❌ Failed to send WhatsApp message:", e.response?.data || e.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 ABTYP Flow Server Live on Port ${PORT}`));
