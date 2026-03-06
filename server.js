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
const WHATSAPP_TOKEN = "EAAb2OhvJlfEBQ26D7U9NSEBTatzRUWpbATSZC0daUlAIjDrZB7z2un13NR2ayVGBhzD4tgfZBZBUt7cZCtz21F1QInyaaON0yeAAsOuKUZB00RcB6KlZAJjjovZCJ1XRKlsC6aeWR6GTG8znFDbr3XF7jLKKPWFwh1pNCBYhrel4UZBO5oLLEbun62rK0Hw0qY6mRDwP95N9VtJbA4mEeL7iinfUqEbZBJgCl2GrR4whuiby4uIS3NQFf4aHKLL0nH4wmNIkynzoZA8dOx9fZA60bmUXZAuja";

const privateKeyInput = process.env.PRIVATE_KEY || "";

const formattedKey = privateKeyInput.includes("BEGIN PRIVATE KEY")
  ? privateKeyInput.replace(/\\n/g, "\n")
  : `-----BEGIN PRIVATE KEY-----\n${privateKeyInput}\n-----END PRIVATE KEY-----`;

const mapList = (arr) =>
  (arr || []).map((item) => ({
    id: item.Id.toString(),
    title: item.Name
  }));

app.post("/", async (req, res) => {

  const { encrypted_aes_key, encrypted_flow_data, initial_vector, authentication_tag } = req.body;

  if (!encrypted_aes_key) return res.status(200).send("OK");

  try {

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
    for (let i = 0; i < requestIv.length; i++) responseIv[i] = ~requestIv[i];

    const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);

    const flowBuffer = Buffer.from(encrypted_flow_data, "base64");

    decipher.setAuthTag(
      authentication_tag
        ? Buffer.from(authentication_tag, "base64")
        : flowBuffer.slice(-16)
    );

    const decrypted =
      decipher.update(
        authentication_tag ? flowBuffer : flowBuffer.slice(0, -16),
        "binary",
        "utf8"
      ) + decipher.final("utf8");

    const decryptedPayload = JSON.parse(decrypted);

    console.log("FULL PAYLOAD:", decryptedPayload);

    const { action, data } = decryptedPayload;

    /* -------- Ping -------- */

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

    /* -------- Complete -------- */

    if (action === "complete") {

      console.log("FLOW COMPLETED");

      try {

        const parishadId = data.parishad_id;

        const linkRes = await axios.get(
          `https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${parishadId}`,
          { headers: ABTYP_HEADERS }
        );

        const groupLink = linkRes.data?.Data?.WhatsAppGroupLink || null;

        const recipient = decryptedPayload.user_id;

        if (recipient && groupLink) {

          await axios.post(
            `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
            {
              messaging_product: "whatsapp",
              to: recipient,
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

        console.error("WHATSAPP ERROR:", err.response?.data || err.message);

      }

      const responsePayload = {
        version: "3.0",
        data: { acknowledged: true }
      };

      const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);

      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(responsePayload), "utf8"),
        cipher.final()
      ]);

      return res
        .status(200)
        .send(Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64"));
    }

    /* -------- Dropdown Data -------- */

    let responseData = {
      country_list: [],
      state_list: [],
      parishad_list: [],
      is_state_enabled: false,
      is_parishad_enabled: false,
      is_submit_enabled: false
    };

    const countryRes = await axios.get(
      "https://api.abtyp.org/v0/country",
      { headers: ABTYP_HEADERS }
    );

    responseData.country_list = mapList(countryRes.data?.Data);

    if (data.country_id) {

      const stateRes = await axios.get(
        `https://api.abtyp.org/v0/state?CountryId=${data.country_id}`,
        { headers: ABTYP_HEADERS }
      );

      responseData.state_list = mapList(stateRes.data?.Data);

      responseData.is_state_enabled = true;

    }

    if (data.state_id) {

      const parishadRes = await axios.get(
        `https://api.abtyp.org/v0/parishad?StateId=${data.state_id}`,
        { headers: ABTYP_HEADERS }
      );

      responseData.parishad_list = mapList(parishadRes.data?.Data);

      responseData.is_parishad_enabled = true;

    }

    if (data.parishad_id) {
      responseData.is_submit_enabled = true;
    }

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

    console.error("SERVER ERROR:", err);

    return res.status(500).send("Error");

  }

});

app.listen(process.env.PORT || 3000, () =>
  console.log("Server Running")
);
