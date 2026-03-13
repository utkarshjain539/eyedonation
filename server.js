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

const PHONE_NUMBER_ID = "185660454629908";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PRIVATE_KEY = process.env.PRIVATE_KEY?.replace(/\\n/g, "\n");

let cachedCountries = null;

/* ---------------- HELPERS ---------------- */
const encryptResponse = (data, aesKey, iv) => {
  const invIv = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) invIv[i] = ~iv[i];
  const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, invIv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return Buffer.concat([enc, cipher.getAuthTag()]).toString("base64");
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
    const sender = decryptedPayload.flow_context?.sender_id || "918488861504";

    console.log(`📱 ACTION: ${action} | USER: ${sender}`);

    // --- LOGIC HANDLING ---

    if (action === "ping") {
      return res.status(200).send(encryptResponse({ version: "7.1", data: { status: "active" } }, aesKey, requestIv));
    }

    if (action === "INIT" || action === "data_exchange") {
      
      // CASE A: User clicked "Continue" - JUMP TO SUCCESS SCREEN
      if (data?.action === "NEXT") {
        console.log(`🚀 SCREEN JUMP: Moving to SUCCESS_SCREEN with Parishad ID: ${data.p_id}`);
        return res.status(200).send(encryptResponse({
            version: "7.1",
            screen: "SUCCESS_SCREEN", // <--- CRITICAL: Change ID to move forward
            data: {
                final_id: data.p_id
            }
        }, aesKey, requestIv));
      }

      // CASE B: Dropdown Logic - STAY ON LOCATION SCREEN
      let resp = {
        version: "7.1",
        screen: "LOCATION_SCREEN",
        data: {
          country_list: [],
          state_list: [],
          parishad_list: [],
          is_state_enabled: false,
          is_parishad_enabled: false,
          can_move_next: false
        }
      };

      // Country Cache
      if (!cachedCountries) {
        const cRes = await axios.get("https://api.abtyp.org/v0/country", { headers: ABTYP_HEADERS });
        cachedCountries = (cRes.data?.Data || []).map(i => ({ id: i.Id.toString(), title: i.Name }));
      }
      resp.data.country_list = cachedCountries;

      // Fetch States
      if (data?.c_id) {
        console.log(`Fetching States for Country: ${data.c_id}`);
        const sRes = await axios.get(`https://api.abtyp.org/v0/state?CountryId=${data.c_id}`, { headers: ABTYP_HEADERS });
        resp.data.state_list = (sRes.data?.Data || []).map(i => ({ id: i.Id.toString(), title: i.Name }));
        resp.data.is_state_enabled = resp.data.state_list.length > 0;
      }

      // Fetch Parishads
      if (data?.s_id) {
        console.log(`Fetching Parishads for State: ${data.s_id}`);
        const pRes = await axios.get(`https://api.abtyp.org/v0/parishad?StateId=${data.s_id}`, { headers: ABTYP_HEADERS });
        resp.data.parishad_list = (pRes.data?.Data || []).map(i => ({ id: i.Id.toString(), title: i.Name }));
        resp.data.is_parishad_enabled = resp.data.parishad_list.length > 0;
      }

      // Enable Continue Button
      if (data?.p_id) {
        resp.data.can_move_next = true;
      }

      return res.status(200).send(encryptResponse(resp, aesKey, requestIv));
    }

    // CASE C: Final Submission from SUCCESS_SCREEN
    if (action === "complete") {
      const pId = data?.parishad_id;
      console.log(`🎯 TARGET HIT: Complete Action received. ID: ${pId} | Sending to: ${sender}`);

      if (pId) {
        sendWhatsAppLink(pId, sender);
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

async function sendWhatsAppLink(pId, to) {
    try {
        console.log(`[API] Fetching link for Parishad: ${pId}`);
        const linkRes = await axios.get(`https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${pId}`, { headers: ABTYP_HEADERS });
        const link = linkRes.data?.Data?.WhatsAppGroupLink;

        if (link) {
            console.log(`[Meta] Sending Link to ${to}`);
            await axios.post(`https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`, {
                messaging_product: "whatsapp",
                to: to,
                type: "text",
                text: { body: `Welcome to ABTYP 🙏\n\nYour Group Link:\n${link}` }
            }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
            
            console.log(`🚀 SUCCESS: Message sent!`);
        }
    } catch (e) {
        console.error("❌ META API ERROR 400:");
        console.error(JSON.stringify(e.response?.data || e.message, null, 2));
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server Live on Port ${PORT}`));
