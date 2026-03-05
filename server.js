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

const mapList = (arr) =>
  (arr || []).map((item) => ({
    id: item.Id.toString(),
    title: item.Name
  }));

/* ================= FLOW HANDLER ================= */

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
    
    const { action, data } = JSON.parse(decrypted);
    console.log("INCOMING ACTION:", action, "DATA:", data);

    if (action === "ping") {
      const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify({ data: { status: "active" } }), "utf8"), cipher.final()]);
      return res.status(200).send(Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64"));
    }

    /* --- DATA FETCHING --- */
    let responseData = {
      country_list: [],
      state_list: [],
      parishad_list: [],
      whatsapp_link: "",
      is_state_enabled: false,
      is_parishad_enabled: false,
      is_link_visible: false
    };

    // Extract IDs from our new payload keys
    const countryId = data?.country_id;
    const stateId = data?.state_id;
    const parishadId = data?.parishad_id;

    // 1. Always get Countries
    const countryRes = await axios.get("https://api.abtyp.org/v0/country", { headers: ABTYP_HEADERS });
    responseData.country_list = mapList(countryRes.data?.Data);

    // 2. Fetch States if Country is selected
    if (countryId) {
      const stateRes = await axios.get(`https://api.abtyp.org/v0/state?CountryId=${countryId}`, { headers: ABTYP_HEADERS });
      responseData.state_list = mapList(stateRes.data?.Data);
      responseData.is_state_enabled = responseData.state_list.length > 0;
    }

    // 3. Fetch Parishads if State is selected
    if (stateId) {
      const parishadRes = await axios.get(`https://api.abtyp.org/v0/parishad?StateId=${stateId}`, { headers: ABTYP_HEADERS });
      responseData.parishad_list = mapList(parishadRes.data?.Data);
      responseData.is_parishad_enabled = responseData.parishad_list.length > 0;
    }

    // 4. Fetch WhatsApp Link if Parishad is selected
    if (parishadId) {
      const linkRes = await axios.get(`https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${parishadId}`, { headers: ABTYP_HEADERS });
      const link = linkRes.data?.Data?.GroupLink || "";
      responseData.whatsapp_link = link;
      responseData.is_link_visible = link.length > 0;
    }
/* --- 5. HANDLE FINAL SUBMISSION --- */
if (data.action === "submit_and_send_msg") {
    
    // 1. Get the link
    const linkRes = await axios.get(`https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${data.parishad_id}`, { headers: ABTYP_HEADERS });
    const groupLink = linkRes.data?.Data?.GroupLink || "No link found";

    // 2. SEND THE WHATSAPP MESSAGE
    // Note: You need your WHATSAPP_TOKEN and PHONE_NUMBER_ID from Meta Dashboard
    try {
        await axios.post(
            `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: "whatsapp",
                to: req.body.phone_number || data.phone_number, // The Flow automatically provides the user's phone number in some configurations
                type: "text",
                text: {
                    body: `Thank you for joining ABTYP! \n\nHere is your requested WhatsApp Group Link: ${groupLink}`
                }
            },
            { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
        );
    } catch (msgErr) {
        console.error("Error sending WhatsApp Message:", msgErr.response?.data || msgErr.message);
    }

    // 3. Tell the flow to close
    const finalResponse = {
        version: "3.0",
        action: "complete", // This closes the flow on the user's phone
        payload: {
            status: "success",
            message: "Link sent to your WhatsApp!"
        }
    };

    const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(finalResponse), "utf8"), cipher.final()]);
    return res.status(200).send(Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64"));
}
    const flowResponse = { version: "3.0", screen: "LOCATION_SCREEN", data: responseData };
    console.log("RESPONSE DATA:", JSON.stringify(responseData));

    /* --- ENCRYPTION --- */
    const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(flowResponse), "utf8"), cipher.final()]);
    return res.status(200).send(Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64"));

  } catch (err) {
    console.error("SERVER ERROR:", err.message);
    return res.status(500).send("Server Error");
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Server Running"));
