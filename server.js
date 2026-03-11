const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json({ type: "*/*" }));

axios.defaults.timeout = 2000;

/* ---------------- CONFIG ---------------- */

const ABTYP_HEADERS = {
  "api-Key": "ABTYP_API_SECRET_KEY_@ABTYP2023#@763^%ggjhg%",
  "Content-Type": "application/json"
};

const PHONE_NUMBER_ID = "908875015643505";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

/* ---------------- PRIVATE KEY FORMAT ---------------- */

const privateKeyInput = process.env.PRIVATE_KEY || "";

let formattedKey;

if (privateKeyInput.includes("BEGIN PRIVATE KEY")) {
  formattedKey = privateKeyInput.replace(/\\n/g, "\n").trim();
} else {
  const cleanKey = privateKeyInput.replace(/\s+/g, '').trim();
  const keyLines = cleanKey.match(/.{1,64}/g) || [];
  formattedKey = `-----BEGIN PRIVATE KEY-----\n${keyLines.join('\n')}\n-----END PRIVATE KEY-----`;
}

/* ---------------- HELPERS ---------------- */

const mapList = (arr) =>
  (arr || []).map(item => ({
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

  return Buffer.concat([
    encrypted,
    cipher.getAuthTag()
  ]).toString("base64");
};

/* ---------------- HEALTH CHECK ---------------- */

app.get("/", (req, res) => {
  res.send("ABTYP WhatsApp Flow Server Running");
});

/* ---------------- FLOW ENDPOINT ---------------- */

app.post("/", async (req, res) => {

  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = req.body;

  /* Meta Health Check Request */
  if (!encrypted_aes_key) {
    return res.status(200).json({
      status: "active"
    });
  }

  try {

    /* ---------------- DECRYPT AES KEY ---------------- */

    const aesKey = crypto.privateDecrypt(
      {
        key: formattedKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256"
      },
      Buffer.from(encrypted_aes_key, "base64")
    );

    /* ---------------- DECRYPT FLOW PAYLOAD ---------------- */

    const flowBuffer = Buffer.from(encrypted_flow_data, "base64");
    const requestIv = Buffer.from(initial_vector, "base64");

    const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);

    decipher.setAuthTag(flowBuffer.slice(-16));

    const decrypted = Buffer.concat([
      decipher.update(flowBuffer.slice(0, -16)),
      decipher.final()
    ]).toString("utf8");

    const payload = JSON.parse(decrypted);

    const { action, data } = payload;

    const senderNumber =
      payload.flow_context?.sender_id ||
      payload.user_id ||
      "919327447138";

    /* ---------------- FLOW LOGIC ---------------- */

    if (action === "INIT" || action === "data_exchange") {

      let resp = {
        version: "3.0",
        screen: "LOCATION_SCREEN",
        data: {
          country_list: [],
          state_list: [],
          parishad_list: [],
          is_state_enabled: false,
          is_parishad_enabled: false,
          status_text: "",
          is_submit_enabled: false
        }
      };

      /* -------- COUNTRY -------- */

      const countryRes = await axios.get(
        "https://api.abtyp.org/v0/country",
        { headers: ABTYP_HEADERS }
      );

      resp.data.country_list = mapList(countryRes.data?.Data);

      /* -------- STATE -------- */

      if (data?.country_id) {

        const stateRes = await axios.get(
          `https://api.abtyp.org/v0/state?CountryId=${data.country_id}`,
          { headers: ABTYP_HEADERS }
        );

        resp.data.state_list = mapList(stateRes.data?.Data);

        resp.data.is_state_enabled =
          resp.data.state_list.length > 0;
      }

      /* -------- PARISHAD -------- */

      if (data?.state_id) {

        const parishadRes = await axios.get(
          `https://api.abtyp.org/v0/parishad?StateId=${data.state_id}`,
          { headers: ABTYP_HEADERS }
        );

        resp.data.parishad_list = mapList(parishadRes.data?.Data);

        resp.data.is_parishad_enabled =
          resp.data.parishad_list.length > 0;
      }

      /* -------- SEND WHATSAPP LINK -------- */

      if (data?.parishad_id) {

        resp.data.status_text =
          "✅ Link sent! Check your WhatsApp.";

        resp.data.is_submit_enabled = true;

        setTimeout(async () => {

          try {

            const linkRes = await axios.get(
              `https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${data.parishad_id}`,
              { headers: ABTYP_HEADERS }
            );

            const link =
              linkRes.data?.Data?.WhatsAppGroupLink;

            if (link) {

              await axios.post(
                `https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`,
                {
                  messaging_product: "whatsapp",
                  to: senderNumber,
                  type: "text",
                  text: {
                    body: `Welcome to ABTYP 🙏\n\nYour Parishad WhatsApp Group Link:\n${link}`
                  }
                },
                {
                  headers: {
                    Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                    "Content-Type": "application/json"
                  }
                }
              );

              console.log(
                `[SUCCESS] Link sent to ${senderNumber}`
              );

            }

          } catch (e) {

            console.error(
              "[WHATSAPP ERROR]",
              e.message
            );

          }

        }, 3000);
      }

      return res
        .status(200)
        .send(encryptResponse(resp, aesKey, requestIv));
    }

    /* ---------------- COMPLETE ---------------- */

    if (action === "complete") {

      return res.status(200).send(
        encryptResponse(
          { data: { acknowledged: true } },
          aesKey,
          requestIv
        )
      );
    }

  } catch (err) {

    console.error("[FLOW ERROR]", err.message);

    return res.status(400).json({
      error: "Flow processing failed"
    });

  }
});

/* ---------------- SERVER ---------------- */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Flow server running on port ${PORT}`);
});
