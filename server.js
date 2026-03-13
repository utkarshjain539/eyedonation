const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json());

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const ABTYP_HEADERS = {
  "api-Key": "ABTYP_API_SECRET_KEY_@ABTYP2023#@763^%ggjhg%",
  "Content-Type": "application/json",
};
const PHONE_NUMBER_ID = "185660454629908";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PRIVATE_KEY = process.env.PRIVATE_KEY?.replace(/\\n/g, "\n");
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "abtyp_verify_token";

// ─── IN-MEMORY SESSION STORE ──────────────────────────────────────────────────
// Stores flow_token -> sender phone number
// Set flow_token = sender's phone number when sending the flow (see sendFlow())
// Then we can retrieve it directly from flow_token on complete
const userSessions = {};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
let cachedCountries = null;

const encryptResponse = (data, aesKey, iv) => {
  const invIv = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) invIv[i] = ~iv[i];
  const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, invIv);
  const enc = Buffer.concat([
    cipher.update(JSON.stringify(data), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([enc, cipher.getAuthTag()]).toString("base64");
};

const decryptRequest = (body) => {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body;
  const aesKey = crypto.privateDecrypt(
    {
      key: PRIVATE_KEY,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
      mgf1Hash: "sha256",
    },
    Buffer.from(encrypted_aes_key, "base64")
  );
  const flowBuffer = Buffer.from(encrypted_flow_data, "base64");
  const requestIv = Buffer.from(initial_vector, "base64");
  const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);
  decipher.setAuthTag(flowBuffer.slice(-16));
  const decryptedPayload = JSON.parse(
    Buffer.concat([
      decipher.update(flowBuffer.slice(0, -16)),
      decipher.final(),
    ]).toString("utf8")
  );
  return { aesKey, requestIv, decryptedPayload };
};

// ─── WEBHOOK VERIFICATION ─────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── INCOMING WHATSAPP MESSAGES (to capture sender phone) ────────────────────
app.post("/webhook", (req, res) => {
  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;
  const messages = value?.messages;

  if (messages?.length > 0) {
    const msg = messages[0];
    const senderPhone = msg.from; // e.g. "919876543210"

    // If user replied to a flow completion (nfm_reply)
    if (msg.type === "interactive" && msg.interactive?.type === "nfm_reply") {
      const responseJson = JSON.parse(
        msg.interactive.nfm_reply.response_json || "{}"
      );
      const flowToken = responseJson.flow_token;
      if (flowToken) {
        console.log(`📱 Flow reply from ${senderPhone}, token: ${flowToken}`);
        userSessions[flowToken] = senderPhone;
      }
    }

    // If user sent a keyword to trigger the flow (e.g. "hi", "join")
    if (msg.type === "text") {
      const text = msg.text?.body?.toLowerCase().trim();
      if (text === "hi" || text === "join" || text === "group") {
        sendFlow(senderPhone); // Send the flow to the user
      }
    }
  }

  res.sendStatus(200);
});

// ─── FLOW ENDPOINT ────────────────────────────────────────────────────────────
app.post("/flow", async (req, res) => {
  // Health check (no encryption)
  if (!req.body.encrypted_aes_key) {
    return res.status(200).json({ status: "active" });
  }

  let aesKey, requestIv, decryptedPayload;
  try {
    ({ aesKey, requestIv, decryptedPayload } = decryptRequest(req.body));
  } catch (err) {
    console.error("🔴 Decryption failed:", err.message);
    return res.status(200).json({ error: "decryption_failed" });
  }

  const { action, data, flow_token } = decryptedPayload;
  console.log(`📱 [${action}] | flow_token: ${flow_token}`);
  console.log("🔍 Payload data:", JSON.stringify(data, null, 2));

  try {
    // ── PING ────────────────────────────────────────────────────────────────
    if (action === "ping") {
      return res.status(200).send(
        encryptResponse(
          { version: "7.1", data: { status: "active" } },
          aesKey,
          requestIv
        )
      );
    }

    // ── INIT / DATA EXCHANGE (dropdown logic) ────────────────────────────────
    if (action === "INIT" || action === "data_exchange") {
      // Fetch countries (cached)
      if (!cachedCountries) {
        const cRes = await axios.get("https://api.abtyp.org/v0/country", {
          headers: ABTYP_HEADERS,
        });
        cachedCountries = (cRes.data?.Data || []).map((i) => ({
          id: i.Id.toString(),
          title: i.Name,
        }));
      }

      const resp = {
        version: "7.1",
        screen: "LOCATION_SCREEN",
        data: {
          country_list: cachedCountries,
          state_list: [],
          parishad_list: [],
          is_state_enabled: false,
          is_parishad_enabled: false,
          can_move_next: false,
        },
      };

      // Fetch states if country selected
      if (data?.c_id) {
        const sRes = await axios.get(
          `https://api.abtyp.org/v0/state?CountryId=${data.c_id}`,
          { headers: ABTYP_HEADERS }
        );
        resp.data.state_list = (sRes.data?.Data || []).map((i) => ({
          id: i.Id.toString(),
          title: i.Name,
        }));
        resp.data.is_state_enabled = resp.data.state_list.length > 0;
      }

      // Fetch parishads if state selected
      if (data?.s_id) {
        const pRes = await axios.get(
          `https://api.abtyp.org/v0/parishad?StateId=${data.s_id}`,
          { headers: ABTYP_HEADERS }
        );
        resp.data.parishad_list = (pRes.data?.Data || []).map((i) => ({
          id: i.Id.toString(),
          title: i.Name,
        }));
        resp.data.is_parishad_enabled = resp.data.parishad_list.length > 0;
      }

      // Enable Continue button if parishad selected
      if (data?.p_id) {
        resp.data.can_move_next = true;
      }

      return res.status(200).send(encryptResponse(resp, aesKey, requestIv));
    }

    // ── COMPLETE (user tapped "Send Me the Link") ────────────────────────────
    if (action === "complete") {
      const parishadId = data.parishad_id;

      // ✅ KEY TRICK: flow_token was set to the user's phone number when we
      // sent the flow (see sendFlow() below), so we can use it directly.
      // Fallback to session store if needed.
      const senderPhone = flow_token || userSessions[flow_token];

      console.log(`✅ COMPLETE | parishad: ${parishadId} | phone: ${senderPhone}`);

      if (senderPhone && parishadId) {
        await sendWhatsAppLink(parishadId, senderPhone);
        if (userSessions[flow_token]) delete userSessions[flow_token];
      } else {
        console.error("❌ Missing phone or parishad ID");
      }

      return res.status(200).send(
        encryptResponse(
          { version: "7.1", data: { acknowledged: true } },
          aesKey,
          requestIv
        )
      );
    }

  } catch (err) {
    console.error("🔴 Server Error:", err.message);
    return res.status(200).json({ error: "server_error" });
  }
});

// ─── SEND FLOW TO USER ────────────────────────────────────────────────────────
async function sendFlow(toPhone) {
  try {
    await axios.post(
      `https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: toPhone,
        type: "interactive",
        interactive: {
          type: "flow",
          header: { type: "text", text: "ABTYP Group Finder 🙏" },
          body: { text: "Find and join your Parishad WhatsApp group." },
          footer: { text: "Powered by ABTYP" },
          action: {
            name: "flow",
            parameters: {
              flow_message_version: "3",
              flow_token: toPhone, // ✅ Set flow_token = phone number for easy retrieval
              flow_id: "YOUR_FLOW_ID", // ← Replace with your actual Flow ID
              flow_cta: "Find My Group",
              flow_action: "navigate",
              flow_action_payload: {
                screen: "LOCATION_SCREEN",
              },
            },
          },
        },
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    console.log(`🚀 Flow sent to ${toPhone}`);
  } catch (e) {
    console.error("❌ sendFlow error:", e.response?.data || e.message);
  }
}

// ─── SEND WHATSAPP LINK MESSAGE ───────────────────────────────────────────────
async function sendWhatsAppLink(pId, to) {
  try {
    const linkRes = await axios.get(
      `https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${pId}`,
      { headers: ABTYP_HEADERS }
    );
    const link = linkRes.data?.Data?.WhatsAppGroupLink;

    if (!link) {
      console.error("❌ No link returned from API for parishad:", pId);
      return;
    }

    await axios.post(
      `https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        type: "text",
        text: {
          body: `Welcome to ABTYP! 🙏\n\nHere is your Parishad WhatsApp group link:\n\n${link}\n\nTap the link above to join your group.`,
        },
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );

    console.log(`🚀 Link sent to ${to}: ${link}`);
  } catch (e) {
    console.error("❌ sendWhatsAppLink error:", e.response?.data || e.message);
  }
}

// ─── START SERVER ─────────────────────────────────────────────────────────────
app.listen(3000, () => console.log("🚀 ABTYP Server running on port 3000"));
