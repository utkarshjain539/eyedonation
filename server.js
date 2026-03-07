const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json());

/* ---------------- CONFIG ---------------- */

const PHONE_NUMBER_ID = "1049088024951885";
const WHATSAPP_TOKEN = "EAAb2OhvJlfEBQ0W2ZA6NCOzyP81B6g6OBg8pqf8SOVPU2VXSnMbL9vk6AHZBZA2bzAR7cdzcaiWh2SVy3S2zqw6YgiTIXboWKqhqmhMgsXw1Xn2Qw2c1brCya1XQ2M51rWuGN0byNTfwBfHEfpwJPKGbpFp5jYZCYTf2hZBJx2Uf8BTYiQg2waaeAhyKxB2iIB0ZBhrGiDKS5p6fHGUTESZBF9ov6RrXxZAz1pjhKn4IEKx8pvySczskJfgDZCdxEKZCNxpSuuj1UTbTMZCjmuyq0BbCIwQewZDZD";
const RECIPIENT_NUMBER = "918488861504";

const ABTYP_HEADERS = {
  "api-Key": "ABTYP_API_SECRET_KEY_@ABTYP2023#@763^%ggjhg%",
  "Content-Type": "application/json"
};

/* ---------------- PRIVATE KEY FROM RENDER ENV ---------------- */

const privateKeyRaw = process.env.PRIVATE_KEY;

const PRIVATE_KEY = privateKeyRaw.includes("BEGIN")
  ? privateKeyRaw.replace(/\\n/g, "\n")
  : `-----BEGIN PRIVATE KEY-----\n${privateKeyRaw}\n-----END PRIVATE KEY-----`;

/* ---------------- UTIL ---------------- */

const mapList = (arr) =>
  (arr || []).map((item) => ({
    id: item.Id.toString(),
    title: item.Name
  }));

/* ---------------- HEALTH CHECK ---------------- */

app.get("/", (req, res) => {
  res.send("ABTYP WhatsApp Flow Server Running");
});

/* ---------------- FLOW ENDPOINT ---------------- */

app.post("/", async (req, res) => {

  try {

    const {
      encrypted_aes_key,
      encrypted_flow_data,
      initial_vector,
      authentication_tag
    } = req.body;

    /* Health check requests */
    if (!encrypted_aes_key) {
      return res.status(200).send("OK");
    }

    /* ---------------- DECRYPT AES KEY ---------------- */

    const aesKey = crypto.privateDecrypt(
      {
        key: PRIVATE_KEY,
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

    /* ---------------- DECRYPT FLOW PAYLOAD ---------------- */

    const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);

    const flowBuffer = Buffer.from(encrypted_flow_data, "base64");

    decipher.setAuthTag(Buffer.from(authentication_tag, "base64"));

    const decrypted =
      decipher.update(flowBuffer, "binary", "utf8") + decipher.final("utf8");

    const payload = JSON.parse(decrypted);

    console.log("FLOW PAYLOAD:", payload);

    const action = payload.action || "";
    const data = payload.data || {};

    /* ---------------- PING ---------------- */

    if (action === "ping") {

      const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);

      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify({ data: { status: "active" } }), "utf8"),
        cipher.final()
      ]);

      return res
        .status(200)
        .send(Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64"));
    }

    /* ---------------- DROPDOWN RESPONSE ---------------- */

    let responseData = {
      country_list: [],
      state_list: [],
      parishad_list: [],
      is_state_enabled: false,
      is_parishad_enabled: false
    };

    /* COUNTRY */

    const countryRes = await axios.get(
      "https://api.abtyp.org/v0/country",
      { headers: ABTYP_HEADERS }
    );

    responseData.country_list = mapList(countryRes.data?.Data);

    /* STATE */

    if (data.country_id) {

      const stateRes = await axios.get(
        `https://api.abtyp.org/v0/state?CountryId=${data.country_id}`,
        { headers: ABTYP_HEADERS }
      );

      responseData.state_list = mapList(stateRes.data?.Data);
      responseData.is_state_enabled = true;
    }

    /* PARISHAD */

    if (data.state_id) {

      const parishadRes = await axios.get(
        `https://api.abtyp.org/v0/parishad?StateId=${data.state_id}`,
        { headers: ABTYP_HEADERS }
      );

      responseData.parishad_list = mapList(parishadRes.data?.Data);
      responseData.is_parishad_enabled = true;
    }

    /* ---------------- SEND GROUP LINK ---------------- */

    if (data.parishad_id) {

      console.log("PARISHAD SELECTED:", data.parishad_id);

      try {

        const linkRes = await axios.get(
          `https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${data.parishad_id}`,
          { headers: ABTYP_HEADERS }
        );

        const groupLink = linkRes.data?.Data?.WhatsAppGroupLink;

        console.log("GROUP LINK:", groupLink);

        if (groupLink) {

          await axios.post(
            `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
            {
              messaging_product: "whatsapp",
              to: RECIPIENT_NUMBER,
              type: "text",
              text: {
                body: `Welcome to ABTYP 🙏

Here is your Parishad WhatsApp Group Link:

${groupLink}`
              }
            },
            {
              headers: {
                Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                "Content-Type": "application/json"
              }
            }
          );

          console.log("WHATSAPP MESSAGE SENT");

        }

      } catch (err) {

        console.log("WHATSAPP ERROR:", err.response?.data || err.message);

      }

    }

    /* ---------------- ENCRYPT RESPONSE ---------------- */

    const responsePayload = {
      version: "3.0",
      screen: "LOCATION_SCREEN",
      data: responseData
    };

    const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);

    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(responsePayload), "utf8"),
      cipher.final()
    ]);

    return res
      .status(200)
      .send(Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64"));

  } catch (err) {

    console.log("SERVER ERROR:", err.message);

    return res.status(500).send("Error");
  }

});

/* ---------------- START SERVER ---------------- */

app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 ABTYP Flow Server Running");
});
