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

const PHONE_NUMBER_ID = "1049088024951885";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN; 
const FIXED_RECIPIENT = "918488861504";

// Private Key Handling
const privateKeyInput = process.env.PRIVATE_KEY || "";
let formattedKey;
if (privateKeyInput.includes("BEGIN PRIVATE KEY")) {
  formattedKey = privateKeyInput.replace(/\\n/g, "\n").trim();
} else {
  const cleanKey = privateKeyInput.replace(/\s+/g, '').trim();
  const keyLines = cleanKey.match(/.{1,64}/g) || [];
  formattedKey = `-----BEGIN PRIVATE KEY-----\n${keyLines.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

/* ---------------- HELPERS ---------------- */
const mapList = (arr) => (arr || []).map(item => ({ 
  id: item.Id?.toString() || "", 
  title: item.Name || "" 
}));

const encryptResponse = (data, aesKey, iv) => {
  const invertedIv = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) invertedIv[i] = ~iv[i];
  const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, invertedIv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64");
};

/* ---------------- MAIN ENDPOINT ---------------- */
app.post("/", async (req, res) => {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = req.body;
  if (!encrypted_aes_key) return res.status(200).send("OK");

  try {
    const aesKey = crypto.privateDecrypt({
      key: formattedKey, 
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, 
      oaepHash: "sha256"
    }, Buffer.from(encrypted_aes_key, "base64"));

    const flowBuffer = Buffer.from(encrypted_flow_data, "base64");
    const requestIv = Buffer.from(initial_vector, "base64");
    const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);
    decipher.setAuthTag(flowBuffer.slice(-16));
    
    const decrypted = Buffer.concat([decipher.update(flowBuffer.slice(0, -16)), decipher.final()]).toString("utf8");
    const { action, data } = JSON.parse(decrypted);

    console.log(`\n[TRACE] Action: ${action} | Data: ${JSON.stringify(data)}`);

    // 1. Handle Meta Ping
    if (action === "ping") {
      return res.status(200).send(encryptResponse({ data: { status: "active" } }, aesKey, requestIv));
    }

    // 2. Handle Dropdowns (INIT & data_exchange)
    if (action === "INIT" || action === "data_exchange") {
      let resp = { 
        version: "3.0", 
        screen: "LOCATION_SCREEN", 
        data: { country_list: [], state_list: [], parishad_list: [], is_state_enabled: false, is_parishad_enabled: false } 
      };
      
      const cRes = await axios.get("https://api.abtyp.org/v0/country", { headers: ABTYP_HEADERS });
      resp.data.country_list = mapList(cRes.data?.Data);

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

    // 3. Handle Final "complete" Action
    // 3. Handle Final "complete" Action (When user clicks the button)
    if (action === "complete") {
      // Note: We use the key 'parishad_id' because that's what is in your latest logs
      const pId = data?.parishad_id || data?.selected_parishad_id;
      
      console.log(`\n[SUBMIT] Processing final submission for Parishad: ${pId}`);

      if (pId) {
        try {
          // STEP 1: Get the link from ABTYP API
          console.log(`[API] Fetching link for Parishad ID: ${pId}...`);
          const linkRes = await axios.get(`https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${pId}`, { 
            headers: ABTYP_HEADERS 
          });
          
          const groupLink = linkRes.data?.Data?.WhatsAppGroupLink;

          if (groupLink) {
            console.log(`[API] Link found: ${groupLink}`);

            // STEP 2: Send the WhatsApp Message via Meta
            console.log(`[META] Sending message to ${FIXED_RECIPIENT}...`);
            const metaRes = await axios.post(
              `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
              {
                messaging_product: "whatsapp",
                to: FIXED_RECIPIENT,
                type: "text",
                text: { 
                  body: `Welcome to ABTYP 🙏\n\nHere is your Parishad WhatsApp Group Link:\n${groupLink}` 
                }
              },
              { 
                headers: { 
                  Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                  "Content-Type": "application/json"
                } 
              }
            );

            console.log(`[SUCCESS] Message sent! Meta ID: ${metaRes.data?.messages?.[0]?.id}`);
          } else {
            console.warn(`[WARN] No link found in ABTYP database for ID: ${pId}`);
          }
        } catch (err) {
          console.error(`[ERROR] Failed to process link or send message:`);
          console.error(err.response?.data || err.message);
        }
      } else {
        console.error("[ERROR] Complete action received but Parishad ID was missing!");
      }

      // Always respond to the Flow so the user sees a "Success" checkmark
      return res.status(200).send(encryptResponse({ data: { acknowledged: true } }, aesKey, requestIv));
    }

  } catch (err) {
    console.error(`[FATAL] Error: ${err.message}`);
    return res.status(400).send("Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 ABTYP Flow Server online on ${PORT}`));
