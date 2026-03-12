const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

axios.defaults.timeout = 5000;

/* ---------------- CONFIG ---------------- */
const ABTYP_HEADERS = {
  "api-Key": "ABTYP_API_SECRET_KEY_@ABTYP2023#@763^%ggjhg%",
  "Content-Type": "application/json"
};

const PHONE_NUMBER_ID = "908875015643505";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PRIVATE_KEY = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, "\n") : null;

if (!PRIVATE_KEY) {
    console.error("❌ CRITICAL ERROR: PRIVATE_KEY environment variable is missing!");
}

// Memory Cache for Countries to speed up Flow interactions
let cachedCountries = null;

/* ---------------- HELPERS ---------------- */
const mapList = (arr) => (arr || []).map((item) => ({
    id: item.Id?.toString() || "",
    title: item.Name || ""
}));

const encryptResponse = (data, aesKey, iv) => {
  const invertedIv = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) {
    invertedIv[i] = ~iv[i];
  }
  const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, invertedIv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64");
};

/* ---------------- ROUTES ---------------- */

app.get("/", (req, res) => {
  res.status(200).send("ABTYP Flow Server is Active");
});

app.post("/", async (req, res) => {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = req.body;

  if (!encrypted_aes_key) {
    console.log("⚠️ Meta Health Check Ping received.");
    return res.status(200).json({ status: "active" });
  }

  let aesKey, requestIv, decryptedPayload;

  try {
    /* STEP 1: RSA DECRYPTION */
    aesKey = crypto.privateDecrypt(
      {
        key: PRIVATE_KEY,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
        mgf1Hash: "sha256", 
      },
      Buffer.from(encrypted_aes_key, "base64")
    );

    /* STEP 2: AES DECRYPTION */
    const flowBuffer = Buffer.from(encrypted_flow_data, "base64");
    requestIv = Buffer.from(initial_vector, "base64");
    const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);
    decipher.setAuthTag(flowBuffer.slice(-16));

    const decrypted = Buffer.concat([
      decipher.update(flowBuffer.slice(0, -16)),
      decipher.final()
    ]).toString("utf8");

    decryptedPayload = JSON.parse(decrypted);

    // --- LOGGING SENDER ID ---
    const action = decryptedPayload.action;
    const senderId = decryptedPayload.flow_context?.sender_id || "NOT_PROVIDED_BY_META";
    
    console.log(`\n-----------------------------------------`);
    console.log(`📱 ACTION: ${action}`);
    console.log(`👤 SENDER: ${senderId}`);
    console.log(`-----------------------------------------`);

    /* STEP 3: LOGIC HANDLING */
    const { data } = decryptedPayload;

    if (action === "ping") {
      return res.status(200).send(
        encryptResponse({ version: "7.1", data: { status: "active" } }, aesKey, requestIv)
      );
    }

    if (action === "INIT" || action === "data_exchange") {
      let resp = {
        version: "7.1",
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

      // Handle Country List (with caching)
      if (!cachedCountries) {
        console.log("Fetching Countries from API...");
        const cRes = await axios.get("https://api.abtyp.org/v0/country", { headers: ABTYP_HEADERS });
        cachedCountries = mapList(cRes.data?.Data);
      }
      resp.data.country_list = cachedCountries;

      // Handle States
      if (data?.country_id) {
        console.log(`Fetching States for Country: ${data.country_id}`);
        const sRes = await axios.get(`https://api.abtyp.org/v0/state?CountryId=${data.country_id}`, { headers: ABTYP_HEADERS });
        resp.data.state_list = mapList(sRes.data?.Data);
        resp.data.is_state_enabled = resp.data.state_list.length > 0;
      }

      // Handle Parishads
      if (data?.state_id) {
        console.log(`Fetching Parishads for State: ${data.state_id}`);
        const pRes = await axios.get(`https://api.abtyp.org/v0/parishad?StateId=${data.state_id}`, { headers: ABTYP_HEADERS });
        resp.data.parishad_list = mapList(pRes.data?.Data);
        resp.data.is_parishad_enabled = resp.data.parishad_list.length > 0;
      }

      // Enable Submit only if a parishad is picked
      if (data?.parishad_id) {
        resp.data.status_text = "✅ Location selected. Press Submit to receive your link.";
        resp.data.is_submit_enabled = true;
      }

      return res.status(200).send(encryptResponse(resp, aesKey, requestIv));
    }

    if (action === "complete") {
      console.log(`🏁 Flow Completed. Data:`, JSON.stringify(data));
      
      if (data?.parishad_id && senderId !== "NOT_PROVIDED_BY_META") {
        // Trigger background message
        sendWhatsAppLink(data.parishad_id, senderId);
      } else {
        console.error("❌ Submission failed: Missing Parishad ID or valid Sender ID.");
      }

      return res.status(200).send(encryptResponse({ 
        version: "7.1", 
        data: { acknowledged: true } 
      }, aesKey, requestIv));
    }

  } catch (err) {
    console.error("🔴 SERVER ERROR:", err.message);
    if (aesKey && requestIv) {
      return res.status(200).send(encryptResponse({ version: "7.1", error: "flow_error", details: err.message }, aesKey, requestIv));
    }
    return res.status(500).json({ error: "decryption_failed" });
  }
});

/* ---------------- BACKGROUND SENDER ---------------- */

async function sendWhatsAppLink(parishadId, to) {
    try {
        console.log(`[Async] Starting message sequence for ${to}...`);
        
        // 1. Get Link
        const linkRes = await axios.get(`https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${parishadId}`, { headers: ABTYP_HEADERS });
        const link = linkRes.data?.Data?.WhatsAppGroupLink;

        if (!link) {
            console.warn(`[Async] No group link found for Parishad ID: ${parishadId}`);
            return;
        }

        // 2. Send WhatsApp
        const metaRes = await axios.post(`https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp",
            to: to,
            type: "text",
            text: { body: `Welcome to ABTYP 🙏\n\nYour Parishad Group Link is below:\n${link}` }
        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });

        console.log(`[Async] ✅ Message sent successfully! Meta ID: ${metaRes.data.messages[0].id}`);

    } catch (e) {
        console.error("[Async] ❌ FAILED to send message:");
        if (e.response) {
            console.error("Meta API Response Error:", JSON.stringify(e.response.data));
        } else {
            console.error(e.message);
        }
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 ABTYP Flow Server Live on Port ${PORT}`);
  console.log(`Ready for interactions...\n`);
});
