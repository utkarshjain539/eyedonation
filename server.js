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

const privateKeyInput = process.env.PRIVATE_KEY || "";
const formattedKey = privateKeyInput.includes("BEGIN PRIVATE KEY")
  ? privateKeyInput.replace(/\\n/g, "\n")
  : `-----BEGIN PRIVATE KEY-----\n${privateKeyInput}\n-----END PRIVATE KEY-----`;

const mapList = (arr) => (arr || []).map((item) => ({
  id: item.Id.toString(),
  title: item.Name
}));

/* ================= ROOT ROUTE ================= */

app.get("/", (req, res) => {
  res.send("ABTYP WhatsApp Flow Server is Running!");
});

/* ================= FLOW HANDLER ================= */

app.post("/", async (req, res) => {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector, authentication_tag } = req.body;

  // Health check/Ping from WhatsApp
  if (!encrypted_aes_key) return res.status(200).send("OK");

  try {
    /* --- 1. DECRYPTION --- */
    const aesKey = crypto.privateDecrypt(
      {
        key: formattedKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256"
      },
      Buffer.from(encrypted_aes_key, "base64")
    );

    const requestIv = Buffer.from(initial_vector, "base64");
    const responseIv = Buffer.alloc(requestIv.length);
    for (let i = 0; i < requestIv.length; i++) {
      responseIv[i] = ~requestIv[i];
    }

    const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);
    const flowBuffer = Buffer.from(encrypted_flow_data, "base64");
    decipher.setAuthTag(authentication_tag ? Buffer.from(authentication_tag, "base64") : flowBuffer.slice(-16));

    const decrypted = decipher.update(authentication_tag ? flowBuffer : flowBuffer.slice(0, -16), "binary", "utf8") + decipher.final("utf8");
    const { action, data } = JSON.parse(decrypted);

    console.log("-----------------------------------------");
    console.log("INCOMING ACTION:", action);
    console.log("INCOMING DATA:", JSON.stringify(data, null, 2));

    /* --- 2. PING ACTION --- */
    if (action === "ping") {
      const pingResponse = { data: { status: "active" } };
      const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(pingResponse), "utf8"), cipher.final()]);
      return res.status(200).send(Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64"));
    }

    /* --- 3. RESPONSE LOGIC --- */
    let flowResponse = {
      version: "3.0",
      screen: "LOCATION_SCREEN", // Default screen
      data: {}
    };

    // Check if the user clicked the 'Get Group Link' button
    if (data && data.action === "submit") {
      console.log("SUBMIT DETECTED: Fetching Link and Navigating...");

      const linkRes = await axios.get(
        `https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${data.parishad_id}`, 
        { headers: ABTYP_HEADERS }
      );
      
      const finalLink = linkRes.data?.Data?.GroupLink || "Link not found";

      // Explicitly switch screens to SUCCESS_SCREEN
      flowResponse.screen = "SUCCESS_SCREEN"; 
      flowResponse.data = { whatsapp_link: finalLink };

    } else {
      // Handle Dropdown Updates / Initial Load
      console.log("REFRESHING: Staying on LOCATION_SCREEN...");
      
      let responseData = {
        country_list: [],
        state_list: [],
        parishad_list: [],
        is_state_enabled: false,
        is_parishad_enabled: false,
        is_submit_enabled: false
      };

      // Always fetch countries to keep the list populated
      const countryRes = await axios.get("https://api.abtyp.org/v0/country", { headers: ABTYP_HEADERS });
      responseData.country_list = mapList(countryRes.data?.Data);

      // Fetch states if country is selected
      if (data && data.country_id) {
        const stateRes = await axios.get(`https://api.abtyp.org/v0/state?CountryId=${data.country_id}`, { headers: ABTYP_HEADERS });
        responseData.state_list = mapList(stateRes.data?.Data);
        responseData.is_state_enabled = responseData.state_list.length > 0;
      }

      // Fetch parishads if state is selected
      if (data && data.state_id) {
        const parishadRes = await axios.get(`https://api.abtyp.org/v0/parishad?StateId=${data.state_id}`, { headers: ABTYP_HEADERS });
        responseData.parishad_list = mapList(parishadRes.data?.Data);
        responseData.is_parishad_enabled = responseData.parishad_list.length > 0;
      }

      // Enable submit button if parishad is selected
      if (data && (data.parishad_id || data.parishad)) {
        responseData.is_submit_enabled = true;
      }

      flowResponse.data = responseData;
    }

    console.log("OUTGOING RESPONSE:", JSON.stringify(flowResponse, null, 2));
    console.log("-----------------------------------------");

    /* --- 4. ENCRYPT & SEND --- */
    const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(flowResponse), "utf8"), cipher.final()]);

    return res.status(200).send(
      Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64")
    );

  } catch (err) {
    console.error("SERVER ERROR:", err.message);
    return res.status(500).send("Internal Server Error");
  }
});

/* ================= START ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ABTYP Server is live on port ${PORT}`);
});
