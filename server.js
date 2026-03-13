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

const PHONE_NUMBER_ID = "185660454629908";
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
    
    // CAPTURE SENDER: Meta automatically sends this in live mode inside flow_context
    const senderNumber = decryptedPayload.flow_context?.sender_id;

    console.log(`\n📱 INTERACTION: ${action} | SENDER: ${senderNumber || 'Testing/Draft'}`);

    if (action === "ping") {
      return res.status(200).send(encryptResponse({ version: "7.1", data: { status: "active" } }, aesKey, requestIv));
    }

    if (action === "INIT" || action === "data_exchange") {
      
      // LOGIC: Transition to Success Screen when "Next" is clicked
      if (data?.action === "GO_TO_SUCCESS") {
        return res.status(200).send(encryptResponse({
            version: "7.1",
            screen: "SUCCESS_SCREEN",
            data: { parishad_id: data.parishad_id }
        }, aesKey, requestIv));
      }

      // LOGIC: Handle Dropdowns
      let resp = {
        version: "7.1",
        screen: "LOCATION_SCREEN",
        data: {
          country_list: [],
          state_list: [],
          parishad_list: [],
          is_state_enabled: false,
          is_parishad_enabled: false,
          is_submit_enabled: false
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

      if (data?.parishad_id) {
        resp.data.is_submit_enabled = true;
      }

      return res.status(200).send(encryptResponse(resp, aesKey, requestIv));
    }
 console.log(`🏁 Flow Complete. Processing for Parishad: ${pId}`);
    if (action === "complete") {
      const pId = data?.parishad_id;
     

      // If we have a real user ID, send it. If not, we use your number for debug.
      const target = senderNumber || "919327447138"; 
      
      if (pId) {
        sendWhatsAppLink(pId, target);
      }

      return res.status(200).send(encryptResponse({ 
        version: "7.1", 
        data: { acknowledged: true } 
      }, aesKey, requestIv));
    }

  } catch (err) {
    console.error("🔴 Server Error:", err.message);
    if (aesKey && requestIv) {
        return res.status(200).send(encryptResponse({ version: "7.1", error: "system_error" }, aesKey, requestIv));
    }
    return res.status(500).json({ error: "decryption_failed" });
  }
});

/* ---------------- BACKGROUND SENDER ---------------- */

async function sendWhatsAppLink(parishadId, to) {
    try {
        console.log(`[API] Fetching link for Parishad: ${parishadId}`);
        const linkRes = await axios.get(`https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${parishadId}`, { headers: ABTYP_HEADERS });
        const link = linkRes.data?.Data?.WhatsAppGroupLink;

        if (link) {
            console.log(`[Meta] Attempting to send link to ${to}`);
            const metaRes = await axios.post(`https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`, {
                messaging_product: "whatsapp",
                to: to,
                type: "text",
                text: { body: `Welcome to ABTYP 🙏\n\nYour Parishad Group Link:\n${link}` }
            }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
            
            console.log(`🚀 SUCCESS! Message ID: ${metaRes.data.messages[0].id}`);
        } else {
            console.warn("⚠️ API returned success but no link found.");
        }
    } catch (e) {
        console.error("❌ META API ERROR 400 DETAIL:");
        if (e.response && e.response.data) {
            console.error(JSON.stringify(e.response.data, null, 2));
        } else {
            console.error(e.message);
        }
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 ABTYP LIVE ON PORT ${PORT}`));
