const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json());

const ABTYP_HEADERS = {
  "api-Key": "ABTYP_API_SECRET_KEY_@ABTYP2023#@763^%ggjhg%",
  "Content-Type": "application/json"
};

const PHONE_NUMBER_ID = "1049088024951885";
const WHATSAPP_TOKEN = "EAAb2OhvJlfEBQw6kATe2EfyCGQNYAe8jHkh6IAZCzYZAp8wqshW74xsVMUQhSpiXCCgpDAF92PvrkJK1ZAEhG4Eq8C9tvmReGyxTOunq0KCBORwchHP067xQ9ziJ8kZB2cHWaOTzJB4EN4HjsXPsPifyjqGASCuG9RMTaYFcWzdlZCVzQO0lwPi0lA4KmKbZBHNi5BzIoJ58ZCsCdSWgxeC2GRQZAuWuSaN2uTPZCJq0Pp0rUZCTpTGacicnh3aEFaEvMM8FV1Cq5RDTuoMtObqEMVYO6ZA";

const privateKeyInput = process.env.PRIVATE_KEY || "";
const formattedKey = privateKeyInput.includes("BEGIN PRIVATE KEY")
  ? privateKeyInput.replace(/\\n/g, "\n")
  : `-----BEGIN PRIVATE KEY-----\n${privateKeyInput}\n-----END PRIVATE KEY-----`;

const mapList = (arr) => (arr || []).map((item) => ({
  id: item.Id.toString(),
  title: item.Name
}));

app.get("/", (req, res) => res.send("ABTYP Flow Server is Active"));

app.post("/", async (req, res) => {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector, authentication_tag } = req.body;
  if (!encrypted_aes_key) return res.status(200).send("OK");

  try {
    const aesKey = crypto.privateDecrypt(
      { key: formattedKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(encrypted_aes_key, "base64")
    );
    const requestIv = Buffer.from(initial_vector, "base64");
    const responseIv = Buffer.alloc(requestIv.length);
    for (let i = 0; i < requestIv.length; i++) responseIv[i] = ~requestIv[i];

    const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);
    const flowBuffer = Buffer.from(encrypted_flow_data, "base64");
    decipher.setAuthTag(authentication_tag ? Buffer.from(authentication_tag, "base64") : flowBuffer.slice(-16));
    const decrypted = decipher.update(authentication_tag ? flowBuffer : flowBuffer.slice(0, -16), "binary", "utf8") + decipher.final("utf8");
    
    const decryptedPayload = JSON.parse(decrypted);
    const { action, data } = decryptedPayload;

    console.log("--- NEW FLOW ACTION ---");
    console.log("Action:", action);

    // --- 1. HANDLE PING ---
    if (action === "ping") {
      console.log("Health Check (Ping) successful");
      const pingResponse = { data: { status: "active" } };
      const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(pingResponse), "utf8"), cipher.final()]);
      return res.status(200).send(Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64"));
    }

    // --- 2. HANDLE COMPLETE ---
    // --- 2. HANDLE COMPLETE ---
    if (action === "complete") {
      console.log("--- STARTING COMPLETION ---");
      // This log helps identify exactly what Meta sends us
      console.log("Full Decrypted Payload for Debug:", JSON.stringify(decryptedPayload));

      const finalResponse = { version: "3.0", data: { acknowledged: true } };

      try {
        const linkRes = await axios.get(`https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${data.parishad_id}`, { headers: ABTYP_HEADERS });
        
        // --- PRINTING LINK TO CONSOLE ---
        console.log("--- ABTYP API RESPONSE ---");
        console.log("Full API Body:", JSON.stringify(linkRes.data, null, 2));
        
        const groupLink = linkRes.data?.Data?.WhatsAppGroupLink;
        console.log("Extracted WhatsApp Group Link:", groupLink);
        // --------------------------------

        const recipient = decryptedPayload.phone_number || data.phone_number || decryptedPayload.user_id;
        console.log("Resolved Recipient Phone:", recipient);

        if (recipient && groupLink) {
          console.log(`Attempting to send message to ${recipient}...`);
          const fbRes = await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp",
            to: recipient.toString().replace('+', ''), // Ensure no '+' sign
            type: "text",
            text: { body: `Here is your ABTYP WhatsApp Group Link: ${groupLink}` }
          }, { 
            headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } 
          });
          console.log("META SUCCESS:", JSON.stringify(fbRes.data));
        } else {
          console.log("FAILURE: Missing Link or Recipient. Link:", !!groupLink, "Recipient:", !!recipient);
        }
      } catch (e) {
        // Log detailed error data if the Meta API or your Link API fails
        console.error("COMPLETION ERROR:", e.response?.data || e.message);
      }

      // Always return encrypted acknowledgement to Meta
      const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(finalResponse), "utf8"), cipher.final()]);
      return res.status(200).send(Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64"));
    }

    // --- 3. DATA EXCHANGE (DROPDOWNS) ---
    console.log("Updating Dropdowns for data:", JSON.stringify(data));
    let responseData = {
      country_list: [], state_list: [], parishad_list: [],
      is_state_enabled: false, is_parishad_enabled: false, is_submit_enabled: false
    };

    const countryRes = await axios.get("https://api.abtyp.org/v0/country", { headers: ABTYP_HEADERS });
    responseData.country_list = mapList(countryRes.data?.Data);

    if (data.country_id) {
      const stateRes = await axios.get(`https://api.abtyp.org/v0/state?CountryId=${data.country_id}`, { headers: ABTYP_HEADERS });
      responseData.state_list = mapList(stateRes.data?.Data);
      responseData.is_state_enabled = responseData.state_list.length > 0;
    }
    if (data.state_id) {
      const parishadRes = await axios.get(`https://api.abtyp.org/v0/parishad?StateId=${data.state_id}`, { headers: ABTYP_HEADERS });
      responseData.parishad_list = mapList(parishadRes.data?.Data);
      responseData.is_parishad_enabled = responseData.parishad_list.length > 0;
    }
    if (data.parishad_id) responseData.is_submit_enabled = true;

    const flowResponse = { version: "3.0", screen: "LOCATION_SCREEN", data: responseData };
    const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(flowResponse), "utf8"), cipher.final()]);
    return res.status(200).send(Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64"));

  } catch (err) {
    console.error("CRITICAL ERROR:", err.message);
    return res.status(500).send("Error");
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Server Running on port 3000"));
