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
    // 1. Decrypt AES Key
    aesKey = crypto.privateDecrypt(
      { key: PRIVATE_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", mgf1Hash: "sha256" },
      Buffer.from(encrypted_aes_key, "base64")
    );

    // 2. Decrypt Payload
    const flowBuffer = Buffer.from(encrypted_flow_data, "base64");
    requestIv = Buffer.from(initial_vector, "base64");
    const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);
    decipher.setAuthTag(flowBuffer.slice(-16));
    const decrypted = Buffer.concat([decipher.update(flowBuffer.slice(0, -16)), decipher.final()]).toString("utf8");
    
    decryptedPayload = JSON.parse(decrypted);

    const { action, data } = decryptedPayload;
    const senderNumber = decryptedPayload.flow_context?.sender_id || "919327447138"; 

    console.log(`\n📱 ACTION: ${action} | USER: ${senderNumber}`);

    // --- LOGIC HANDLING ---

    if (action === "ping") {
      return res.status(200).send(encryptResponse({ version: "7.1", data: { status: "active" } }, aesKey, requestIv));
    }

    if (action === "INIT" || action === "data_exchange") {
      
      // CASE A: User clicked "Next" on the first screen
      if (data?.action === "GO_TO_SUCCESS") {
        console.log(`➡️ Routing to SUCCESS_SCREEN for Parishad: ${data.parishad_id}`);
        return res.status(200).send(encryptResponse({
            version: "7.1",
            screen: "SUCCESS_SCREEN",
            data: {
                parishad_id: data.parishad_id
            }
        }, aesKey, requestIv));
      }

      // CASE B: Dropdown Logic for LOCATION_SCREEN
      let resp = {
        version: "7.1",
        screen: "LOCATION_SCREEN",
        data: {
          country_list: [],
          state_list: [],
          parishad_list: [],
          is_state_enabled: false,
          is_parishad_enabled: false
        }
      };

      if (!cachedCountries) {
        const cRes = await axios.get("https://api.abtyp.org/v0/country", { headers: ABTYP_HEADERS });
        cachedCountries = mapList(cRes.data?.Data);
      }
      resp.data.country_list = cachedCountries;

      if (data?.country_id) {
        const sRes = await axios.get(`https://api.abtyp.org/v0/state?CountryId=${data.country_id}`, { headers: ABTYP_HEADERS });
        resp.data.state_list = mapList(sRes.data?.Data);
        resp.data.is_state_enabled = resp.data.state_list.length > 0;
      }

      if (data?.state_id) {
        const pRes = await axios.get(`https://api.abtyp.org/v0/parishad?StateId=${data.state_id}`, { headers: ABTYP_HEADERS });
        resp.data.parishad_list = mapList(pRes.data?.Data);
        resp.data.is_parishad_enabled = resp.data.parishad_list.length > 0;
      }

      return res.status(200).send(encryptResponse(resp, aesKey, requestIv));
    }

    // CASE C: Final Submission (Success Screen "Finish" Button)
    if (action === "complete") {
      const parishadId = data?.parishad_id;
      console.log(`🎯 TARGET HIT: Complete Action received for Parishad: ${parishadId}`);

      if (parishadId) {
          sendWhatsAppLink(parishadId, senderNumber);
      } else {
          console.error("❌ ERROR: Complete action received but parishad_id is missing.");
      }

      return res.status(200).send(encryptResponse({ 
        version: "7.1", 
        data: { acknowledged: true } 
      }, aesKey, requestIv));
    }

  } catch (err) {
    console.error("🔴 SERVER ERROR:", err.message);
    if (aesKey && requestIv) {
        return res.status(200).send(encryptResponse({ version: "7.1", error: "system_error" }, aesKey, requestIv));
    }
    return res.status(500).json({ error: "error" });
  }
});

/* ---------------- BACKGROUND SENDER ---------------- */

async function sendWhatsAppLink(parishadId, to) {
    try {
        console.log(`[Background] Fetching link for ID: ${parishadId}...`);
        const linkRes = await axios.get(`https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${parishadId}`, { headers: ABTYP_HEADERS });
        const link = linkRes.data?.Data?.WhatsAppGroupLink;

        if (link) {
            console.log(`[Background] Sending WhatsApp to: ${to}`);
            await axios.post(`https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`, {
                messaging_product: "whatsapp",
                to: to,
                type: "text",
                text: { body: `Welcome to ABTYP 🙏\n\nYour Parishad Group Link:\n${link}` }
            }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });

            console.log(`🚀 SUCCESS: Message sent to ${to}`);
        } else {
            console.warn(`⚠️ API Success but no link found for Parishad ${parishadId}`);
        }
    } catch (e) {
        console.error("❌ Background Sender Error:", e.response?.data || e.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 ABTYP Server Live on Port ${PORT}`));
