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
const WHATSAPP_TOKEN = "EAAb2OhvJlfEBQ88ZCzIsoJq5ZCy9i0pyvmyG4pSRSe6dF8SvDZC7XFZCeKYQlUaabve1sjxMh8rnbsPUkZAAKp2fNcvq0Gg8qqH2BDUKu0yaD0lrZCOPFPUiVaEHgZBC2jSVsv2U6hTL0ZBcNviAARZAnVgieRzlZBpkXkvqZANbx9nFwkZC5sNeL8MhgUMIDtNZA2W0Il3LXOPNUrbuzZCZCGJgHPfOymGVENYTWCovIZCC8qkWsCMbDIVY";

/* ---------------- PRIVATE KEY ---------------- */

const privateKeyInput = process.env.PRIVATE_KEY || "";

const formattedKey = privateKeyInput.includes("BEGIN PRIVATE KEY")
  ? privateKeyInput.replace(/\\n/g, "\n")
  : `-----BEGIN PRIVATE KEY-----\n${privateKeyInput}\n-----END PRIVATE KEY-----`;

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
  const {
    encrypted_aes_key,
    encrypted_flow_data,
    initial_vector,
    authentication_tag
  } = req.body;

  if (!encrypted_aes_key) {
    return res.status(200).send("OK");
  }

  try {
    /* ---------- DECRYPT AES KEY ---------- */
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

    /* ---------- DECRYPT PAYLOAD ---------- */
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
    const { action, data } = decryptedPayload;

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

    /* ---------------- COMPLETE (FLOW SUBMIT) ---------------- */
    if (action === "complete") {
      try {
        const parishadId = data.parishad_id;
        const recipient = decryptedPayload.user_id;

        if (parishadId && recipient) {
          const linkRes = await axios.get(
            `https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${parishadId}`,
            { headers: ABTYP_HEADERS }
          );

          const groupLink = linkRes.data?.Data?.WhatsAppGroupLink;

          if (groupLink) {
            await axios.post(
              `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
              {
                messaging_product: "whatsapp",
                to: recipient,
                type: "text",
                text: {
                  body: `Welcome to ABTYP 🙏\n\nHere is your Parishad WhatsApp Group Link:\n\n${groupLink}`
                }
              },
              {
                headers: {
                  Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                  "Content-Type": "application/json"
                }
              }
            );
          }
        }
      } catch (error) {
        // Silent fail - don't let WhatsApp errors break the flow response
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

    /* ---------------- DROPDOWN DATA ---------------- */
    let responseData = {
      country_list: [],
      state_list: [],
      parishad_list: [],
      is_state_enabled: false,
      is_parishad_enabled: false
    };

    // Country
    const countryRes = await axios.get(
      "https://api.abtyp.org/v0/country",
      { headers: ABTYP_HEADERS }
    );
    responseData.country_list = mapList(countryRes.data?.Data);

    // State
    if (data.country_id) {
      const stateRes = await axios.get(
        `https://api.abtyp.org/v0/state?CountryId=${data.country_id}`,
        { headers: ABTYP_HEADERS }
      );
      responseData.state_list = mapList(stateRes.data?.Data);
      responseData.is_state_enabled = responseData.state_list.length > 0;
    }

    // Parishad
    if (data.state_id) {
      const parishadRes = await axios.get(
        `https://api.abtyp.org/v0/parishad?StateId=${data.state_id}`,
        { headers: ABTYP_HEADERS }
      );
      responseData.parishad_list = mapList(parishadRes.data?.Data);
      responseData.is_parishad_enabled = responseData.parishad_list.length > 0;
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
    return res.status(500).send("Error");
  }
});

/* ---------------- START SERVER ---------------- */

app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 ABTYP WhatsApp Flow Server Running");
});
