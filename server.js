const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json());

/* ================= CONFIG ================= */
const ABTYP_HEADERS = {
  "api-Key": "ABTYP_API_SECRET_KEY_@ABTYP2023#@763^%ggjhg%",
  "Content-Type": "application/json"
};

// You need these from your Meta Developer Dashboard
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

const privateKeyInput = process.env.PRIVATE_KEY || "";
const formattedKey = privateKeyInput.includes("BEGIN PRIVATE KEY")
  ? privateKeyInput.replace(/\\n/g, "\n")
  : `-----BEGIN PRIVATE KEY-----\n${privateKeyInput}\n-----END PRIVATE KEY-----`;

const mapList = (arr) => (arr || []).map((item) => ({
  id: item.Id.toString(),
  title: item.Name
}));

app.get("/", (req, res) => res.send("ABTYP Flow Server Active"));

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
    const { action, data, flow_token } = JSON.parse(decrypted);

    console.log("INCOMING DATA:", JSON.stringify(data, null, 2));

    /* --- HANDLING COMPLETION & SENDING MESSAGE --- */
    if (action === "complete" || (data && data.action === "submit")) {
      console.log("SENDING WHATSAPP MESSAGE...");

      // 1. Fetch Group Link
      const linkRes = await axios.get(`https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${data.parishad_id}`, { headers: ABTYP_HEADERS });
      const groupLink = linkRes.data?.Data?.GroupLink || "Link not found";

      // 2. Send Message via Meta API
      // Note: User's phone number is usually in the request metadata or provided in the flow data
      try {
        await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
          messaging_product: "whatsapp",
          to: data.phone_number || "RECIPIENT_NUMBER", // Replace with dynamic user number
          type: "text",
          text: { body: `Your ABTYP WhatsApp Group Link is: ${groupLink}` }
        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
      } catch (e) { console.error("Message Error:", e.response?.data || e.message); }

      // 3. Close the flow
      return res.status(200).send("Flow Completed Successfully");
    }

    /* --- DROPDOWN REFRESH LOGIC --- */
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
    return res.status(500).send("Error");
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Server Running"));
