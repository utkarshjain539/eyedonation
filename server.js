const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "10mb" }));

/* PRIVATE KEY FROM RENDER ENV */
const PRIVATE_KEY = process.env.PRIVATE_KEY.replace(/\\n/g, "\n");


/* DECRYPT REQUEST */
function decryptRequest(body) {

  const encryptedAesKey = Buffer.from(body.encrypted_aes_key, "base64");
  const encryptedData = Buffer.from(body.encrypted_flow_data, "base64");
  const iv = Buffer.from(body.initial_vector, "base64");

  const aesKey = crypto.privateDecrypt(
    {
      key: PRIVATE_KEY,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING
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
    iv
  };
}


/* ENCRYPT RESPONSE */
function encryptResponse(response, aesKey, iv) {

  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);

  let encrypted = cipher.update(JSON.stringify(response), "utf8");
  encrypted = Buffer.concat([encrypted, cipher.final()]);

  const tag = cipher.getAuthTag();

  return Buffer.concat([encrypted, tag]).toString("base64");
}


/* FLOW ENDPOINT */
app.post("/", async (req, res) => {

  try {

    const { decryptedBody, aesKey, iv } = decryptRequest(req.body);

    console.log("Decrypted Request:", decryptedBody);

    const { action, screen, data } = decryptedBody;

    let response = {};

    /* INIT → LOAD COUNTRY */
    if (action === "INIT") {

      const countryAPI = await axios.get(
        "https://api.abtyp.org/w0/get-country"
      );

      response = {
        screen: "COUNTRY_SCREEN",
        data: {
          country: countryAPI.data.Data.map(c => ({
            id: String(c.Id),
            title: c.Name
          }))
        }
      };
    }

    /* LOAD STATES */
    else if (screen === "STATE_SCREEN") {

      const stateAPI = await axios.get(
        `https://api.abtyp.org/w0/get-state?CountryId=${data.country}`
      );

      response = {
        screen: "STATE_SCREEN",
        data: {
          state: stateAPI.data.Data.map(s => ({
            id: String(s.Id),
            title: s.Name
          }))
        }
      };
    }

    /* LOAD PARISHAD */
    else if (screen === "PARISHAD_SCREEN") {

      const parishadAPI = await axios.get(
        `https://api.abtyp.org/w0/get-parishad?StateId=${data.state}`
      );

      response = {
        screen: "PARISHAD_SCREEN",
        data: {
          parishad: parishadAPI.data.Data.map(p => ({
            id: String(p.Id),
            title: p.Name
          }))
        }
      };
    }

    /* FINAL SCREEN → GROUP LINK */
    else if (screen === "SUCCESS_SCREEN") {

      const linkAPI = await axios.get(
        `https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${data.parishad}`
      );

      response = {
        screen: "SUCCESS_SCREEN",
        data: {
          link: linkAPI.data.Data.GroupLink
        }
      };
    }

    /* ENCRYPT RESPONSE */
    const encryptedResponse = encryptResponse(response, aesKey, iv);

    res.json({
      encrypted_flow_data: encryptedResponse
    });

  } catch (error) {

    console.error("Flow Error:", error);

    res.status(500).send("Server Error");
  }
});


/* START SERVER */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
