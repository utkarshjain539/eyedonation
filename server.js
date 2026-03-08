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

/* ---------------- ENDPOINT ---------------- */
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
    const { action, data, screen } = JSON.parse(decrypted);

    // Default structure to avoid "Decrypted response not as expected"
    let responsePayload = { 
      version: "3.0", 
      screen: screen || "LOCATION_SCREEN", 
      data: {
        country_list: [],
        state_list: [],
        parishad_list: [],
        is_state_enabled: false,
        is_parishad_enabled: false
      } 
    };

    if (action === "INIT" || action === "data_exchange") {
      // 1. Fetch Countries - This MUST succeed for the first screen to load
      try {
        const countryRes = await axios.get("https://api.abtyp.org/v0/country", { 
          headers: ABTYP_HEADERS,
          timeout: 5000 // Add a timeout
        });
        
        const countries = mapList(countryRes.data?.Data);
        
        // If API is empty, provide a fallback so the Flow doesn't crash
        responsePayload.data.country_list = countries.length > 0 
          ? countries 
          : [{ id: "100", title: "India" }]; 

      } catch (e) {
        console.error("Country Fetch Failed:", e.message);
        // CRITICAL: Provide a fallback item so the Flow can at least open
        responsePayload.data.country_list = [{ id: "100", title: "India" }];
      }

      // 2. Handle State Selection
      if (data?.country_id) {
        try {
          const stateRes = await axios.get(`https://api.abtyp.org/v0/state?CountryId=${data.country_id}`, { headers: ABTYP_HEADERS });
          responsePayload.data.state_list = mapList(stateRes.data?.Data);
          responsePayload.data.is_state_enabled = responsePayload.data.state_list.length > 0;
        } catch (e) { console.error("State Fetch Failed"); }
      }

      // 3. Handle Parishad Selection
      if (data?.state_id) {
        try {
          const parishadRes = await axios.get(`https://api.abtyp.org/v0/parishad?StateId=${data.state_id}`, { headers: ABTYP_HEADERS });
          responsePayload.data.parishad_list = mapList(parishadRes.data?.Data);
          responsePayload.data.is_parishad_enabled = responsePayload.data.parishad_list.length > 0;
        } catch (e) { console.error("Parishad Fetch Failed"); }
      }
    }
    
    else if (action === "complete") {
      const pId = data?.parishad_id;
      if (pId) {
        axios.get(`https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${pId}`, { headers: ABTYP_HEADERS })
          .then(linkRes => {
            const link = linkRes.data?.Data?.WhatsAppGroupLink;
            if (link) {
              return axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`, {
                messaging_product: "whatsapp",
                to: FIXED_RECIPIENT,
                type: "text",
                text: { body: `Welcome to ABTYP 🙏\n\nYour Parishad WhatsApp Group Link: ${link}` }
              }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
            }
          }).catch(e => console.error("WA Send Error:", e.response?.data || e.message));
      }
      responsePayload.data = { acknowledged: true };
    }

    return res.status(200).send(encryptResponse(responsePayload, aesKey, requestIv));

  } catch (err) {
    console.error("Server Error:", err.message);
    return res.status(400).send("Decryption Failed");
  }
});

app.listen(process.env.PORT || 3000);
