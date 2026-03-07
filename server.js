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
const WHATSAPP_TOKEN = "EAAb2OhvJlfEBQ0W2ZA6NCOzyP81B6g6OBg8pqf8SOVPU2VXSnMbL9vk6AHZBZA2bzAR7cdzcaiWh2SVy3S2zqw6YgiTIXboWKqhqmhMgsXw1Xn2Qw2c1brCya1XQ2M51rWuGN0byNTfwBfHEfpwJPKGbpFp5jYZCYTf2hZBJx2Uf8BTYiQg2waaeAhyKxB2iIB0ZBhrGiDKS5p6fHGUTESZBF9ov6RrXxZAz1pjhKn4IEKx8pvySczskJfgDZCdxEKZCNxpSuuj1UTbTMZCjmuyq0BbCIwQewZDZD";
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

/* ---------------- UTIL ---------------- */

const mapList = (arr) =>
  (arr || []).map((item) => ({
    id: item.Id?.toString() || "",
    title: item.Name || ""
  }));

const encryptResponse = (data, aesKey, iv) => {
  const invertedIv = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) {
    invertedIv[i] = ~iv[i];
  }

  const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, invertedIv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(data), "utf8"),
    cipher.final()
  ]);
  return Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64");
};

/* ---------------- FLOW ENDPOINT ---------------- */

app.post("/", async (req, res) => {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = req.body;

  if (!encrypted_aes_key || !encrypted_flow_data || !initial_vector) {
    return res.status(200).send("OK"); // Health check/Ping from Meta
  }

  let aesKey;
  const requestIv = Buffer.from(initial_vector, "base64");

  try {
    // 1. Decrypt AES Key
    aesKey = crypto.privateDecrypt(
      {
        key: formattedKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256"
      },
      Buffer.from(encrypted_aes_key, "base64")
    );

    // 2. Decrypt Payload
    const flowBuffer = Buffer.from(encrypted_flow_data, "base64");
    const authTag = flowBuffer.slice(-16);
    const encryptedData = flowBuffer.slice(0, -16);
    const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);
    decipher.setAuthTag(authTag);
    
    const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]).toString("utf8");
    const { action, data, screen } = JSON.parse(decrypted);

    console.log(`Action: ${action}, Screen: ${screen}`);

    // 3. Handle Actions
    let responsePayload = {
      version: "3.0",
      screen: screen || "LOCATION_SCREEN",
      data: {}
    };

    if (action === "ping") {
      responsePayload.data = { status: "active" };
    } 
    
    else if (action === "INIT" || action === "data_exchange") {
      let responseData = {
        country_list: [],
        state_list: [],
        parishad_list: [],
        is_state_enabled: false,
        is_parishad_enabled: false
      };

      // Country Fetch
      try {
        const countryRes = await axios.get("https://api.abtyp.org/v0/country", { headers: ABTYP_HEADERS, timeout: 5000 });
        responseData.country_list = mapList(countryRes.data?.Data);
      } catch (e) { console.error("Country Error:", e.message); }

      // State Fetch
      if (data?.country_id) {
        try {
          const stateRes = await axios.get(`https://api.abtyp.org/v0/state?CountryId=${data.country_id}`, { headers: ABTYP_HEADERS });
          responseData.state_list = mapList(stateRes.data?.Data);
          responseData.is_state_enabled = responseData.state_list.length > 0;
        } catch (e) { console.error("State Error:", e.message); }
      }

      // Parishad Fetch
      if (data?.state_id) {
        try {
          const parishadRes = await axios.get(`https://api.abtyp.org/v0/parishad?StateId=${data.state_id}`, { headers: ABTYP_HEADERS });
          responseData.parishad_list = mapList(parishadRes.data?.Data);
          responseData.is_parishad_enabled = responseData.parishad_list.length > 0;
        } catch (e) { console.error("Parishad Error:", e.message); }
      }

      responsePayload.data = responseData;
    }

    else if (action === "complete") {
      // Fire-and-forget WhatsApp Message
      const parishadId = data?.parishad_id;
      if (parishadId) {
        axios.get(`https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${parishadId}`, { headers: ABTYP_HEADERS })
          .then(res => {
            const groupLink = res.data?.Data?.WhatsAppGroupLink;
            if (groupLink) {
              return axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`, {
                messaging_product: "whatsapp",
                to: FIXED_RECIPIENT,
                type: "text",
                text: { body: `Welcome to ABTYP 🙏\n\nYour Parishad Link:\n${groupLink}` }
              }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
            }
          }).catch(e => console.error("Async Error:", e.message));
      }

      responsePayload.data = { acknowledged: true };
    }

    // 4. Send Encrypted Response
    const finalBase64 = encryptResponse(responsePayload, aesKey, requestIv);
    return res.status(200).send(finalBase64);

  } catch (err) {
    console.error("Critical Decryption/Server Error:", err.message);
    // If decryption fails, the error is likely the Private Key mismatch.
    // Return 400 or a specific error so it's visible in Flow logs.
    return res.status(400).send("Decryption Failed");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
