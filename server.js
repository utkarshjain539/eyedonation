const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json());

/* ---------------- CONFIG ---------------- */
const ABTYP_HEADERS = { "api-Key": "ABTYP_API_SECRET_KEY_@ABTYP2023#@763^%ggjhg%", "Content-Type": "application/json" };
const PHONE_NUMBER_ID = "185660454629908";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PRIVATE_KEY = process.env.PRIVATE_KEY?.replace(/\\n/g, "\n");

let cachedCountries = null;

const encryptResponse = (data, aesKey, iv) => {
  const invertedIv = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) { invertedIv[i] = ~iv[i]; }
  const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, invertedIv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64");
};

app.post("/", async (req, res) => {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = req.body;
  if (!encrypted_aes_key) return res.status(200).json({ status: "active" });

  try {
    const aesKey = crypto.privateDecrypt({ key: PRIVATE_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", mgf1Hash: "sha256" }, Buffer.from(encrypted_aes_key, "base64"));
    const flowBuffer = Buffer.from(encrypted_flow_data, "base64");
    const requestIv = Buffer.from(initial_vector, "base64");
    const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);
    decipher.setAuthTag(flowBuffer.slice(-16));
    const decryptedPayload = JSON.parse(Buffer.concat([decipher.update(flowBuffer.slice(0, -16)), decipher.final()]).toString("utf8"));

    const { action, data } = decryptedPayload;
    // CRITICAL: Always use your real number for testing since Meta sends "Testing" in Drafts
    const senderNumber = (decryptedPayload.flow_context?.sender_id && decryptedPayload.flow_context.sender_id !== "Testing") 
                         ? decryptedPayload.flow_context.sender_id 
                         : "918488861504"; 

    console.log(`📱 [${action}] | User: ${senderNumber}`);

    if (action === "ping") return res.status(200).send(encryptResponse({ version: "7.1", data: { status: "active" } }, aesKey, requestIv));

    if (action === "INIT" || action === "data_exchange") {
      // 1. Move to Success Screen
      if (data?.action === "NEXT_SCREEN") {
        console.log("➡️ Transitioning to SUCCESS_SCREEN");
        return res.status(200).send(encryptResponse({
          version: "7.1", screen: "SUCCESS_SCREEN", data: { p_id: data.parishad_id }
        }, aesKey, requestIv));
      }

      // 2. Standard Dropdown Logic
      let resp = { version: "7.1", screen: "LOCATION_SCREEN", data: { country_list: [], state_list: [], parishad_list: [], is_state_enabled: false, is_parishad_enabled: false } };
      
      if (!cachedCountries) {
        const cRes = await axios.get("https://api.abtyp.org/v0/country", { headers: ABTYP_HEADERS });
        resp.data.country_list = (cRes.data?.Data || []).map(i => ({ id: i.Id.toString(), title: i.Name }));
        cachedCountries = resp.data.country_list;
      } else { resp.data.country_list = cachedCountries; }

      if (data?.country_id) {
        const sRes = await axios.get(`https://api.abtyp.org/v0/state?CountryId=${data.country_id}`, { headers: ABTYP_HEADERS });
        resp.data.state_list = (sRes.data?.Data || []).map(i => ({ id: i.Id.toString(), title: i.Name }));
        resp.data.is_state_enabled = resp.data.state_list.length > 0;
      }
      if (data?.state_id) {
        const pRes = await axios.get(`https://api.abtyp.org/v0/parishad?StateId=${data.state_id}`, { headers: ABTYP_HEADERS });
        resp.data.parishad_list = (pRes.data?.Data || []).map(i => ({ id: i.Id.toString(), title: i.Name }));
        resp.data.is_parishad_enabled = resp.data.parishad_list.length > 0;
      }

      return res.status(200).send(encryptResponse(resp, aesKey, requestIv));
    }

    if (action === "complete") {
      const finalId = data?.final_parishad_id;
      console.log(`✅ COMPLETE RECEIVED! ID: ${finalId} | Sending to: ${senderNumber}`);
      
      if (finalId) {
          sendWhatsAppLink(finalId, senderNumber);
      }
      return res.status(200).send(encryptResponse({ version: "7.1", data: { acknowledged: true } }, aesKey, requestIv));
    }

  } catch (err) {
    console.error("🔴 Error:", err.message);
    return res.status(200).json({ error: "retry" });
  }
});

async function sendWhatsAppLink(parishadId, to) {
    try {
        const linkRes = await axios.get(`https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${parishadId}`, { headers: ABTYP_HEADERS });
        const link = linkRes.data?.Data?.WhatsAppGroupLink;
        if (link) {
            await axios.post(`https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`, {
                messaging_product: "whatsapp", to: to, type: "text", text: { body: `Welcome to ABTYP 🙏\n\nYour Group Link:\n${link}` }
            }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
            console.log("🚀 Link Sent Successfully!");
        }
    } catch (e) { console.error("❌ Meta API Error:", JSON.stringify(e.response?.data || e.message)); }
}

app.listen(3000, () => console.log("🚀 Final Build Live on 3000"));
