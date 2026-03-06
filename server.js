const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json());

console.log("🚀 ABTYP WhatsApp Flow Server Started");

/* ---------------- CONFIG ---------------- */

const PHONE_NUMBER_ID = "1049088024951885";
const WHATSAPP_TOKEN = "EAAb2OhvJlfEBQ7HLSdh7qIKZAnAPBx54WKIwqoz2GA3twqVRjNZA7wbsBhP2r8xFVGtZBhg8cyFj9Y8VEnocxJ9MG47Sqdd1GC7WWoIl2A2XQhL94AqsfFaXGZCSzmf5SPz1PZAXyCI9ZC8MJ0C56W52GpU9TZBFayZBJkZCfzkJ2EznKHNMag830dKxB9ZBmU0FxFlnkTUiQslSrRrh8g96wC75Tl2QEIcs3IZCjfFuARGN9BxpD7ulw9fs2SasZAZBupNFb1iNju7b8qCcSKZCtHDix0qrGb";

const ABTYP_HEADERS = {
  "api-Key": "ABTYP_API_SECRET_KEY_@ABTYP2023#@763^%ggjhg%",
  "Content-Type": "application/json"
};

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
  res.send("ABTYP Flow Server Running");
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
    for (let i = 0; i < requestIv.length; i++) {
      responseIv[i] = ~requestIv[i];
    }

    /* ---------- DECRYPT FLOW PAYLOAD ---------- */

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

    const payload = JSON.parse(decrypted);

    console.log("\n================ FLOW REQUEST ================");
    console.log("TIME:", new Date().toISOString());
    console.log("DECRYPTED PAYLOAD:");
    console.log(JSON.stringify(payload, null, 2));

    const action = payload.action;
    const data = payload?.data || {};

    console.log("ACTION:", action);
    console.log("DATA:", data);

    /* ---------------- PING ---------------- */

    if (action === "ping") {

      const responsePayload = {
        data: {
          status: "active"
        }
      };

      const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);

      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(responsePayload), "utf8"),
        cipher.final()
      ]);

      return res.status(200).send(
        Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64")
      );
    }

    /* ---------------- COMPLETE (SUBMIT BUTTON) ---------------- */

    if (action === "complete") {

      console.log("FLOW SUBMITTED");

      try {

        const parishadId = data.parishad_id;

        console.log("PARISHAD:", parishadId);

        const linkRes = await axios.get(
          `https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${parishadId}`,
          { headers: ABTYP_HEADERS }
        );

        console.log("GROUP LINK API RESPONSE:", linkRes.data);

        const groupLink = linkRes.data?.Data?.WhatsAppGroupLink;

        // const recipient =
        //   payload.user_id ||
        //   payload?.context?.user_id ||
        //   null;
const recipient = "918488861504";
        console.log("RECIPIENT:", recipient);
        console.log("GROUP LINK:", groupLink);

        if (recipient && groupLink) {

          const waResponse = await axios.post(
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

          console.log("WHATSAPP SENT:", waResponse.data);
        }

      } catch (err) {

        console.error("WHATSAPP ERROR:", err.response?.data || err.message);

      }

      const responsePayload = {
        version: "3.0",
        data: {
          acknowledged: true
        }
      };

      const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);

      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(responsePayload), "utf8"),
        cipher.final()
      ]);

      return res.status(200).send(
        Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64")
      );
    }

    /* ---------------- DROPDOWN DATA ---------------- */

    let responseData = {
      country_list: [],
      state_list: [],
      parishad_list: [],
      is_state_enabled: false,
      is_parishad_enabled: false,
      is_submit_enabled: false
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

    /* ENABLE SUBMIT BUTTON */

    if (data.parishad_id) {

      console.log("PARISHAD SELECTED:", data.parishad_id);

      responseData.is_submit_enabled = true;
    }

    console.log("RESPONSE DATA:", responseData);

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

    return res.status(200).send(
      Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64")
    );

  } catch (err) {

    console.error("SERVER ERROR:", err);

    return res.status(500).send("Error");
  }
});

/* ---------------- START SERVER ---------------- */

app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Server Running on Port 3000");
});
