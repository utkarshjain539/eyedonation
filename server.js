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

/* ---------------- MAIN ENDPOINT ---------------- */
app.post("/", async (req, res) => {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = req.body;
  if (!encrypted_aes_key) return res.status(200).send("OK");

  console.log("\n--- NEW FLOW REQUEST ---");

  try {
    // 1. Decrypt Keys
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
    const payload = JSON.parse(decrypted);
    const { action, data, screen } = payload;

    console.log(`[FLOW] Action: ${action} | Screen: ${screen}`);
    if (data) console.log(`[FLOW] Data received:`, JSON.stringify(data));

    // --- CASE A: PING ---
    if (action === "ping") {
      console.log("[DEBUG] Responding to Ping test");
      return res.status(200).send(encryptResponse({ data: { status: "active" } }, aesKey, requestIv));
    }

    // --- CASE B: SCREEN INTERACTIONS ---
    let responsePayload = { 
      version: "3.0", 
      screen: screen || "LOCATION_SCREEN", 
      data: { country_list: [], state_list: [], parishad_list: [], is_state_enabled: false, is_parishad_enabled: false } 
    };

    if (action === "INIT" || action === "data_exchange") {
      console.log("[DEBUG] Fetching dropdown data from ABTYP API...");
      try {
        const countryRes = await axios.get("https://api.abtyp.org/v0/country", { headers: ABTYP_HEADERS, timeout: 5000 });
        responsePayload.data.country_list = mapList(countryRes.data?.Data);
        console.log(`[API] Countries found: ${responsePayload.data.country_list.length}`);
      } catch (e) {
        console.error("[API ERROR] Country fetch failed:", e.message);
        responsePayload.data.country_list = [{ id: "100", title: "India" }];
      }

      if (data?.country_id) {
        try {
          const stateRes = await axios.get(`https://api.abtyp.org/v0/state?CountryId=${data.country_id}`, { headers: ABTYP_HEADERS });
          responsePayload.data.state_list = mapList(stateRes.data?.Data);
          responsePayload.data.is_state_enabled = responsePayload.data.state_list.length > 0;
          console.log(`[API] States found: ${responsePayload.data.state_list.length}`);
        } catch (e) { console.error("[API ERROR] State fetch failed"); }
      }

      if (data?.state_id) {
        try {
          const parishadRes = await axios.get(`https://api.abtyp.org/v0/parishad?StateId=${data.state_id}`, { headers: ABTYP_HEADERS });
          responsePayload.data.parishad_list = mapList(parishadRes.data?.Data);
          responsePayload.data.is_parishad_enabled = responsePayload.data.parishad_list.length > 0;
          console.log(`[API] Parishads found: ${responsePayload.data.parishad_list.length}`);
        } catch (e) { console.error("[API ERROR] Parishad fetch failed"); }
      }
    } 
    
    // --- CASE C: COMPLETE (THE CRITICAL PART) ---
    else if (action === "complete") {
      const pId = data?.parishad_id;
      console.log(`[SUBMIT] Final Parishad selected: ${pId}`);

      if (pId) {
        console.log(`[SUBMIT] Fetching group link for Parishad: ${pId}`);
        
        // Use async/await here so we can log the response before completing
        try {
          const linkRes = await axios.get(`https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${pId}`, { headers: ABTYP_HEADERS });
          const link = linkRes.data?.Data?.WhatsAppGroupLink;
          
          if (link) {
            console.log(`[SUBMIT] Link found: ${link}. Sending message to Meta...`);
            
            const waRes = await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`, {
              messaging_product: "whatsapp",
              to: FIXED_RECIPIENT,
              type: "text",
              text: { body: `Welcome to ABTYP 🙏\n\nYour Parishad WhatsApp Group Link: ${link}` }
            }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });

            console.log(`[META] Message sent successfully! ID: ${waRes.data?.messages?.[0]?.id}`);
          } else {
            console.warn(`[WARN] No link found in ABTYP API response for Parishad ${pId}`);
          }
        } catch (e) {
          console.error("[FATAL] Message failed to send.");
          console.error("Details:", e.response?.data || e.message);
        }
      } else {
        console.warn("[WARN] Action 'complete' triggered but parishad_id was missing from payload.");
      }
      
      responsePayload.data = { acknowledged: true };
    }

    return res.status(200).send(encryptResponse(responsePayload, aesKey, requestIv));

  } catch (err) {
    console.error("[CRITICAL] Decryption or Logic Error:", err.message);
    return res.status(400).send("Decryption Failed");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 ABTYP Server Live on port ${PORT}`));
