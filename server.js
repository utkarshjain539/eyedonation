const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json());

const ABTYP_HEADERS = {
  "api-Key": "ABTYP_API_SECRET_KEY_@ABTYP2023#@763^%ggjhg%",
  "Content-Type": "application/json"
};

const PHONE_NUMBER_ID = "185660454629908";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PRIVATE_KEY = process.env.PRIVATE_KEY?.replace(/\\n/g, "\n");

let cachedCountries = null;

function encryptResponse(data, aesKey, iv) {
  const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(data), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([encrypted, tag]).toString("base64");
}

app.post("/", async (req, res) => {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = req.body;

  if (!encrypted_aes_key) {
    return res.status(200).json({ status: "active" });
  }

  try {
    const aesKey = crypto.privateDecrypt(
      {
        key: PRIVATE_KEY,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256"
      },
      Buffer.from(encrypted_aes_key, "base64")
    );

    const flowBuffer = Buffer.from(encrypted_flow_data, "base64");
    const iv = Buffer.from(initial_vector, "base64");

    const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, iv);
    decipher.setAuthTag(flowBuffer.slice(-16));

    const decrypted = Buffer.concat([
      decipher.update(flowBuffer.slice(0, -16)),
      decipher.final()
    ]);

    const payload = JSON.parse(decrypted.toString("utf8"));

    const action = payload.action;
    const data = payload.data || {};
    const sender = payload.flow_context?.sender_id || "";

    console.log("ACTION:", action);
    console.log("DATA:", data);

    if (action === "ping") {
      return res
        .status(200)
        .send(encryptResponse({ version: "7.1", data: { status: "active" } }, aesKey, iv));
    }

    if (action === "INIT" || action === "data_exchange") {

      if (data?.action === "GO_TO_FINISH") {
        return res.status(200).send(
          encryptResponse(
            {
              version: "7.1",
              screen: "SUMMARY_SCREEN",
              data: { final_p_id: data.p_id }
            },
            aesKey,
            iv
          )
        );
      }

      let response = {
        version: "7.1",
        screen: "LOCATION_SCREEN",
        data: {
          country_list: [],
          state_list: [],
          parishad_list: [],
          is_state_enabled: false,
          is_parishad_enabled: false,
          can_move_next: false
        }
      };

      if (!cachedCountries) {
        const countryRes = await axios.get(
          "https://api.abtyp.org/v0/country",
          { headers: ABTYP_HEADERS }
        );

        cachedCountries = (countryRes.data.Data || []).map(c => ({
          id: c.Id.toString(),
          title: c.Name
        }));
      }

      response.data.country_list = cachedCountries;

      if (data.c_id) {
        const stateRes = await axios.get(
          `https://api.abtyp.org/v0/state?CountryId=${data.c_id}`,
          { headers: ABTYP_HEADERS }
        );

        response.data.state_list = (stateRes.data.Data || []).map(s => ({
          id: s.Id.toString(),
          title: s.Name
        }));

        if (response.data.state_list.length > 0) {
          response.data.is_state_enabled = true;
        }
      }

      if (data.s_id) {
        const parishadRes = await axios.get(
          `https://api.abtyp.org/v0/parishad?StateId=${data.s_id}`,
          { headers: ABTYP_HEADERS }
        );

        response.data.parishad_list = (parishadRes.data.Data || []).map(p => ({
          id: p.Id.toString(),
          title: p.Name
        }));

        if (response.data.parishad_list.length > 0) {
          response.data.is_parishad_enabled = true;
        }
      }

      if (data.p_id) {
        response.data.can_move_next = true;
      }

      return res.status(200).send(encryptResponse(response, aesKey, iv));
    }

    if (action === "complete") {
      await sendWhatsAppLink(data.parishad_id, sender);

      return res.status(200).send(
        encryptResponse(
          { version: "7.1", data: { acknowledged: true } },
          aesKey,
          iv
        )
      );
    }

  } catch (error) {
    console.error("Server Error:", error.message);
    return res.status(200).json({ status: "error" });
  }
});

async function sendWhatsAppLink(parishadId, user) {
  try {
    const res = await axios.get(
      `https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${parishadId}`,
      { headers: ABTYP_HEADERS }
    );

    const link = res.data?.Data?.WhatsAppGroupLink;

    if (!link) return;

    await axios.post(
      `https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: user,
        type: "text",
        text: {
          body: `Welcome to ABTYP 🙏\n\nJoin your Parishad group:\n${link}`
        }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("WhatsApp link sent");
  } catch (err) {
    console.log("WhatsApp send error:", err.message);
  }
}

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
