const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "10mb" }));

/* ============================= */
/* PRIVATE KEY FROM RENDER ENV   */
/* ============================= */

const PRIVATE_KEY = process.env.PRIVATE_KEY
  ? process.env.PRIVATE_KEY.replace(/\\n/g, "\n")
  : null;

if (!PRIVATE_KEY) {
  console.error("PRIVATE_KEY not found in environment variables.");
}

/* ============================= */
/* HEALTH CHECK                  */
/* ============================= */

app.get("/", (req, res) => {
  res.send("ABTYP WhatsApp Flow Server Running");
});

/* ============================= */
/* DECRYPT WHATSAPP FLOW REQUEST */
/* ============================= */

function decryptRequest(body) {
  const encryptedAesKey = Buffer.from(body.encrypted_aes_key, "base64");
  const encryptedData = Buffer.from(body.encrypted_flow_data, "base64");
  const iv = Buffer.from(body.initial_vector, "base64");

  const aesKey = crypto.privateDecrypt(
    {
      key: PRIVATE_KEY,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    },
    encryptedAesKey
  );

  const tag = encryptedData.slice(encryptedData.length - 16);
  const text = encryptedData.slice(0, encryptedData.length - 16);

  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(text);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return {
    decryptedBody: JSON.parse(decrypted.toString()),
    aesKey,
    iv,
  };
}

/* ============================= */
/* ENCRYPT RESPONSE              */
/* ============================= */

function encryptResponse(response, aesKey, iv) {
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);

  let encrypted = cipher.update(JSON.stringify(response), "utf8");
  encrypted = Buffer.concat([encrypted, cipher.final()]);

  const tag = cipher.getAuthTag();

  return Buffer.concat([encrypted, tag]).toString("base64");
}

/* ============================= */
/* FLOW ENDPOINT                 */
/* ============================= */

app.post("/", async (req, res) => {
  try {
    const { decryptedBody, aesKey, iv } = decryptRequest(req.body);

    console.log("Flow Request:", decryptedBody);

    const { action, screen, data } = decryptedBody;

    let response = {};

    /* INIT → LOAD COUNTRIES */

    if (action === "INIT") {
      const api = await axios.get("https://api.abtyp.org/w0/get-country");

      response = {
        screen: "COUNTRY_SCREEN",
        data: {
          country: api.data.Data.map((c) => ({
            id: String(c.Id),
            title: c.Name,
          })),
        },
      };
    }

    /* STATE SCREEN */

    else if (screen === "STATE_SCREEN") {
      const api = await axios.get(
        `https://api.abtyp.org/w0/get-state?CountryId=${data.country}`
      );

      response = {
        screen: "STATE_SCREEN",
        data: {
          state: api.data.Data.map((s) => ({
            id: String(s.Id),
            title: s.Name,
          })),
        },
      };
    }

    /* PARISHAD SCREEN */

    else if (screen === "PARISHAD_SCREEN") {
      const api = await axios.get(
        `https://api.abtyp.org/w0/get-parishad?StateId=${data.state}`
      );

      response = {
        screen: "PARISHAD_SCREEN",
        data: {
          parishad: api.data.Data.map((p) => ({
            id: String(p.Id),
            title: p.Name,
          })),
        },
      };
    }

    /* FINAL SCREEN → GROUP LINK */

    else if (screen === "SUCCESS_SCREEN") {
      const api = await axios.get(
        `https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${data.parishad}`
      );

      response = {
        screen: "SUCCESS_SCREEN",
        data: {
          group_link: api.data.Data.GroupLink,
        },
      };
    }

    const encryptedResponse = encryptResponse(response, aesKey, iv);

    res.json({
      encrypted_flow_data: encryptedResponse,
    });
  } catch (error) {
    console.error("FLOW ERROR:", error);

    res.status(500).send("Server Error");
  }
});

/* ============================= */
/* START SERVER                  */
/* ============================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
