const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json());

/* CONFIG */

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

app.get("/", (req, res) => {
  res.send("ABTYP Flow Server Running");
});

app.post("/", async (req, res) => {

  const { encrypted_aes_key, encrypted_flow_data, initial_vector, authentication_tag } = req.body;

  if (!encrypted_aes_key) {
    return res.status(200).send("OK");
  }

  try {

    /* RSA DECRYPT */

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

    /* AES DECRYPT */

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

    const { action, screen, data } = payload;

    console.log("Incoming:", payload);

    /* ===== PING ===== */

    if (action === "ping") {

      const response = {
        data: {
          status: "active"
        }
      };

      const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);

      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(response), "utf8"),
        cipher.final()
      ]);

      return res.status(200).send(
        Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64")
      );
    }

    /* ===== FLOW ===== */

    let response = {
      version: "3.0",
      screen: "",
      data: {}
    };

    /* INIT */

    if (action === "INIT") {

      const countryRes = await axios.get(
        "https://api.abtyp.org/v0/country",
        { headers: ABTYP_HEADERS }
      );

      response.screen = "COUNTRY_SCREEN";

      response.data = {
        country: mapList(countryRes.data?.Data)
      };
    }

    /* COUNTRY → STATE */

    else if (screen === "COUNTRY_SCREEN") {

      const stateRes = await axios.get(
        `https://api.abtyp.org/v0/state?CountryId=${data.country}`,
        { headers: ABTYP_HEADERS }
      );

      response.screen = "STATE_SCREEN";

      response.data = {
        state: mapList(stateRes.data?.Data)
      };
    }

    /* STATE → PARISHAD */

    else if (screen === "STATE_SCREEN") {

      const parishadRes = await axios.get(
        `https://api.abtyp.org/v0/parishad?StateId=${data.state}`,
        { headers: ABTYP_HEADERS }
      );

      response.screen = "PARISHAD_SCREEN";

      response.data = {
        parishad: mapList(parishadRes.data?.Data)
      };
    }

    /* PARISHAD → GROUP */

    else if (screen === "PARISHAD_SCREEN") {

      const linkRes = await axios.get(
        `https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${data.parishad}`,
        { headers: ABTYP_HEADERS }
      );

      response.screen = "SUCCESS_SCREEN";

      response.data = {
        whatsapp_link: linkRes.data?.Data?.GroupLink || ""
      };
    }

    /* ENCRYPT RESPONSE */

    const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);

    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(response), "utf8"),
      cipher.final()
    ]);

    return res.status(200).send(
      Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64")
    );

  } catch (err) {

    console.error("Server Error:", err);

    return res.status(500).send("Server Error");

  }

});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server Running");
});
