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
    /* --- DECRYPTION --- */
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

    /* --- 1. HANDLE PING (VERIFICATION) --- */
    // This fixes the "Decrypted response not as expected" health check error
    if (action === "ping") {
      const pingResponse = { data: { status: "active" } };
      const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(pingResponse), "utf8"), cipher.final()]);
      return res.status(200).send(Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64"));
    }

    /* --- 2. HANDLE COMPLETE (FINAL BUTTON) --- */
    /* --- HANDLE COMPLETION (SEND LINK AS MESSAGE) --- */
    if (action === "complete") {
      const finalResponse = { version: "3.0", data: { acknowledged: true } };

      try {
        // 1. Fetch Link from your API
        const linkRes = await axios.get(`https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${data.parishad_id}`, { headers: ABTYP_HEADERS });
        
        // FIX: Using the exact key "WhatsAppGroupLink" from your provided JSON
        const groupLink = linkRes.data?.Data?.WhatsAppGroupLink;
        const prabhari = linkRes.data?.Data?.StatePrabhariName || "Admin";

        // 2. Determine recipient
        const recipient = decryptedPayload.phone_number || data.phone_number;
        
        if (recipient) {
          // 3. Construct the message body
          const messageText = groupLink 
            ? `Hello! Here is your ABTYP WhatsApp Group Link: ${groupLink}\n\nContact: ${prabhari}`
            : "Hello! Your ABTYP registration is complete. We will send your group link shortly.";

          // 4. Send the message
          await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp",
            to: recipient,
            type: "text",
            text: { body: messageText }
          }, { 
            headers: { 
              Authorization: `Bearer ${WHATSAPP_TOKEN}`,
              "Content-Type": "application/json"
            } 
          });
          console.log("Test message sent to:", recipient);
        }
      } catch (e) {
        console.error("Message delivery failed:", e.response?.data || e.message);
      }

      // 5. Always return encrypted 200 OK to Meta
      const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(finalResponse), "utf8"), cipher.final()]);
      return res.status(200).send(Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64"));
    }

    /* --- 3. HANDLE DATA_EXCHANGE (DROPDOWNS) --- */
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
    console.error("SERVER ERROR:", err.message);
    return res.status(500).send("Error");
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Server Running"));
