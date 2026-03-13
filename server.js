const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const app = express();
app.use(express.json());

const ABTYP_HEADERS = { "api-Key": "ABTYP_API_SECRET_KEY_@ABTYP2023#@763^%ggjhg%", "Content-Type": "application/json" };
const PHONE_NUMBER_ID = "185660454629908";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PRIVATE_KEY = process.env.PRIVATE_KEY?.replace(/\\n/g, "\n");

let cachedCountries = null;

const encryptResponse = (data, aesKey, iv) => {
  const invIv = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) invIv[i] = ~iv[i];
  const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, invIv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return Buffer.concat([enc, cipher.getAuthTag()]).toString("base64");
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
    const sender = decryptedPayload.flow_context?.sender_id;

    console.log(`📱 [${action}] | User: ${sender}`);

    if (action === "ping") return res.status(200).send(encryptResponse({ version: "7.1", data: { status: "active" } }, aesKey, requestIv));

    if (action === "INIT" || action === "data_exchange") {
      // THE JUMP LOGIC
      if (data?.action === "NEXT") {
        console.log("🚀 Switching to SUCCESS_SCREEN");
        return res.status(200).send(encryptResponse({
          version: "7.1",
          screen: "SUCCESS_SCREEN",
          data: { final_id: data.p_id }
        }, aesKey, requestIv));
      }

      // THE DROPDOWN LOGIC
      let resp = { version: "7.1", screen: "LOCATION_SCREEN", data: { country_list: [], state_list: [], parishad_list: [], is_state_enabled: false, is_parishad_enabled: false, can_move_next: false } };
      
      if (!cachedCountries) {
        const cRes = await axios.get("https://api.abtyp.org/v0/country", { headers: ABTYP_HEADERS });
        cachedCountries = (cRes.data?.Data || []).map(i => ({ id: i.Id.toString(), title: i.Name }));
      }
      resp.data.country_list = cachedCountries;

      if (data?.c_id) {
        const sRes = await axios.get(`https://api.abtyp.org/v0/state?CountryId=${data.c_id}`, { headers: ABTYP_HEADERS });
        resp.data.state_list = (sRes.data?.Data || []).map(i => ({ id: i.Id.toString(), title: i.Name }));
        resp.data.is_state_enabled = resp.data.state_list.length > 0;
      }
      if (data?.s_id) {
        const pRes = await axios.get(`https://api.abtyp.org/v0/parishad?StateId=${data.s_id}`, { headers: ABTYP_HEADERS });
        resp.data.parishad_list = (pRes.data?.Data || []).map(i => ({ id: i.Id.toString(), title: i.Name }));
        resp.data.is_parishad_enabled = resp.data.parishad_list.length > 0;
      }
      if (data?.p_id) {
        resp.data.can_move_next = true;
      }

      return res.status(200).send(encryptResponse(resp, aesKey, requestIv));
    }

    if (action === "complete") {
      console.log(`✅ ACTION COMPLETE! Final ID: ${data.parishad_id}`);
      sendWhatsAppLink(data.parishad_id, sender);
      return res.status(200).send(encryptResponse({ version: "7.1", data: { acknowledged: true } }, aesKey, requestIv));
    }

  } catch (err) {
    console.error("🔴 Error:", err.message);
    return res.status(200).json({ error: "fail" });
  }
});

async function sendWhatsAppLink(pId, to) {
    try {
        const linkRes = await axios.get(`https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${pId}`, { headers: ABTYP_HEADERS });
        const link = linkRes.data?.Data?.WhatsAppGroupLink;
        if (link) {
            await axios.post(`https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`, {
                messaging_product: "whatsapp", to: to, type: "text", text: { body: `Welcome to ABTYP 🙏\n\nLink:\n${link}` }
            }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
            console.log("🚀 Message Sent!");
        }
    } catch (e) { console.error("❌ Meta API Error:", e.response?.data); }
}

app.listen(3000, () => console.log("🚀 Server Live"));
