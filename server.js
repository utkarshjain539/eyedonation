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

console.log("🚀 Server Booted");

/* ================= HELPERS ================= */

const mapList = (arr) =>
  (arr || []).map((item) => ({
    id: item.Id.toString(),
    title: item.Name
  }));

/* ================= ROOT ================= */

app.get("/", (req, res) => {
  res.status(200).send("🚀 ABTYP WhatsApp Flow Running");
});

/* ================= FLOW HANDLER ================= */

app.post("/", async (req, res) => {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector, authentication_tag } = req.body;

  if (!encrypted_aes_key) {
    return res.status(200).send("OK");
  }

  try {

    /* ===== RSA DECRYPT ===== */

    const aesKey = crypto.privateDecrypt(
      {
        key: formattedKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256"
      },
      Buffer.from(encrypted_aes_key, "base64")
    );

    /* ===== AES IV PREP ===== */

    const requestIv = Buffer.from(initial_vector, "base64");
    const responseIv = Buffer.alloc(requestIv.length);

    for (let i = 0; i < requestIv.length; i++) {
      responseIv[i] = ~requestIv[i];
    }

    /* ===== AES DECRYPT ===== */

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

    const { action, screen, data } = JSON.parse(decrypted);

    console.log("➡️ Action:", action);
    console.log("➡️ Screen:", screen);
    console.log("➡️ Data:", data);

    let responsePayloadObj = {
      version: "3.0",
      screen: "",
      data: {}
    };

    /* ================= INIT ================= */

    if (action === "INIT") {

      const countryRes = await axios.get(
        "https://api.abtyp.org/v0/country",
        { headers: ABTYP_HEADERS }
      );

      responsePayloadObj.screen = "LOCATION_SELECT";

      responsePayloadObj.data = {
        country_list: mapList(countryRes.data?.Data || []),
        state_list: [],
        parishad_list: [],
        country: "",
        state: "",
        parishad: ""
      };
    }

    /* ================= DATA EXCHANGE ================= */

    else if (action === "data_exchange") {

      /* LOAD STATES */

      if (data.country && !data.state) {

        const stateRes = await axios.get(
          `https://api.abtyp.org/v0/state?CountryId=${data.country}`,
          { headers: ABTYP_HEADERS }
        );

        responsePayloadObj.screen = "LOCATION_SELECT";

        responsePayloadObj.data = {
          country_list: [],
          state_list: mapList(stateRes.data?.Data || []),
          parishad_list: [],
          country: data.country,
          state: "",
          parishad: ""
        };
      }

      /* LOAD PARISHAD */

      else if (data.state && !data.parishad) {

        const parishadRes = await axios.get(
          `https://api.abtyp.org/v0/parishad?StateId=${data.state}`,
          { headers: ABTYP_HEADERS }
        );

        responsePayloadObj.screen = "LOCATION_SELECT";

        responsePayloadObj.data = {
          country_list: [],
          state_list: [],
          parishad_list: mapList(parishadRes.data?.Data || []),
          country: data.country,
          state: data.state,
          parishad: ""
        };
      }

      /* FINAL STEP → GROUP LINK */

      else if (data.parishad) {

        const linkRes = await axios.get(
          `https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${data.parishad}`,
          { headers: ABTYP_HEADERS }
        );

        responsePayloadObj.screen = "GROUP_LINK";

        responsePayloadObj.data = {
          whatsapp_link: linkRes.data?.Data?.GroupLink || ""
        };
      }
    }

    /* ================= FALLBACK ================= */

    if (!responsePayloadObj.screen) {

      const countryRes = await axios.get(
        "https://api.abtyp.org/v0/country",
        { headers: ABTYP_HEADERS }
      );

      responsePayloadObj.screen = "LOCATION_SELECT";

      responsePayloadObj.data = {
        country_list: mapList(countryRes.data?.Data || []),
        state_list: [],
        parishad_list: [],
        country: "",
        state: "",
        parishad: ""
      };
    }

    console.log("📤 Response:", responsePayloadObj);

    /* ===== ENCRYPT RESPONSE ===== */

    const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);

    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(responsePayloadObj), "utf8"),
      cipher.final()
    ]);

    return res.status(200).send(
      Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64")
    );

  } catch (err) {

    console.error("❌ ERROR:", err.message);

    return res.status(500).send("Server Error");
  }
});

/* ================= START ================= */

app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Server Running");
});
