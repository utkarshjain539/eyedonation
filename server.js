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

// Ensure Private Key is loaded correctly
const PRIVATE_KEY = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, "\n") : null;

if (!PRIVATE_KEY) {
    console.error("❌ CRITICAL ERROR: PRIVATE_KEY environment variable is missing!");
}

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

// 1. Browser/Meta GET Health Check
app.get("/", (req, res) => {
  console.log("--- GET Health Check Received ---");
  res.status(200).send("ABTYP Flow Server is Active");
});

// 2. Main Flow POST Endpoint
app.post("/", async (req, res) => {
  console.log("\n--- New POST Request Received ---");
  
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = req.body;

  // Check if this is a health check ping from Meta
  if (!encrypted_aes_key) {
    console.log("⚠️ Meta Health Check Ping (No encrypted_aes_key found). Returning 200 OK.");
    return res.status(200).json({ status: "active" });
  }

  let aesKey, requestIv, decryptedPayload;

  try {
    /* STEP 1: RSA DECRYPTION */
    console.log("Step 1: Attempting RSA Decryption of AES Key...");
    try {
        aesKey = crypto.privateDecrypt(
          {
            key: PRIVATE_KEY,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: "sha256",
            mgf1Hash: "sha256", 
          },
          Buffer.from(encrypted_aes_key, "base64")
        );
        console.log("✅ RSA Decryption Success.");
    } catch (rsaErr) {
        console.error("❌ RSA Decryption Failed. Check your Private Key or Padding settings.");
        throw rsaErr;
    }

    /* STEP 2: AES DECRYPTION */
    console.log("Step 2: Attempting AES Decryption of Flow Data...");
    try {
        const flowBuffer = Buffer.from(encrypted_flow_data, "base64");
        requestIv = Buffer.from(initial_vector, "base64");

        const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);
        decipher.setAuthTag(flowBuffer.slice(-16));

        const decrypted = Buffer.concat([
          decipher.update(flowBuffer.slice(0, -16)),
          decipher.final()
        ]).toString("utf8");

        decryptedPayload = JSON.parse(decrypted);
        console.log("✅ AES Decryption Success. Action:", decryptedPayload.action);
    } catch (aesErr) {
        console.error("❌ AES Decryption Failed. Auth tag might be wrong.");
        throw aesErr;
    }

    /* STEP 3: LOGIC HANDLING */
    const { action, data } = decryptedPayload;
    const senderNumber = decryptedPayload.flow_context?.sender_id || "919327447138";
// --- ADD THIS BLOCK HERE ---
    if (action === "ping") {
      console.log("Step 3: Handling PING. Returning Pong...");
      return res.status(200).send(
        encryptResponse({ data: { status: "active" } }, aesKey, requestIv)
      );
    }
    if (action === "INIT" || action === "data_exchange") {
      console.log(`Step 3: Handling ${action}. CountryID: ${data?.country_id}, StateID: ${data?.state_id}`);
      
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

      // API Call: Countries
      console.log("Fetching Country List...");
      const cRes = await axios.get("https://api.abtyp.org/v0/country", { headers: ABTYP_HEADERS });
      resp.data.country_list = mapList(cRes.data?.Data);

      // API Call: States
      if (data?.country_id) {
        console.log(`Fetching States for Country: ${data.country_id}`);
        const sRes = await axios.get(`https://api.abtyp.org/v0/state?CountryId=${data.country_id}`, { headers: ABTYP_HEADERS });
        resp.data.state_list = mapList(sRes.data?.Data);
        resp.data.is_state_enabled = resp.data.state_list.length > 0;
      }

      // API Call: Parishads
      if (data?.state_id) {
        console.log(`Fetching Parishads for State: ${data.state_id}`);
        const pRes = await axios.get(`https://api.abtyp.org/v0/parishad?StateId=${data.state_id}`, { headers: ABTYP_HEADERS });
        resp.data.parishad_list = mapList(pRes.data?.Data);
        resp.data.is_parishad_enabled = resp.data.parishad_list.length > 0;
      }

      // Parishad Selected?
      if (data?.parishad_id) {
        console.log(`Parishad Selected: ${data.parishad_id}. Triggering link...`);
        resp.data.status_text = "✅ Success! Check WhatsApp.";
        resp.data.is_submit_enabled = true;
        // Run in background
        sendWhatsAppLink(data.parishad_id, senderNumber);
      }

      console.log("Step 4: Encrypting and Sending Response...");
      return res.status(200).send(encryptResponse(resp, aesKey, requestIv));
    }

    if (action === "complete") {
      console.log("Step 3: Flow Completed. Returning Acknowledgment.");
      return res.status(200).send(encryptResponse({ data: { acknowledged: true } }, aesKey, requestIv));
    }

  } catch (err) {
    console.error("🔴 FLOW PROCESSING ERROR:", err.message);
    
    if (aesKey && requestIv) {
      console.log("Sending Encrypted Error Response...");
      return res.status(200).send(encryptResponse({ error: "flow_error", details: err.message }, aesKey, requestIv));
    }
    
    return res.status(200).json({ error: "processing_error" });
  }
});

/* ---------------- BACKGROUND SENDER ---------------- */

async function sendWhatsAppLink(parishadId, to) {
    try {
        console.log(`[Async] Getting link for Parishad: ${parishadId}`);
        const linkRes = await axios.get(`https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${parishadId}`, { headers: ABTYP_HEADERS });
        const link = linkRes.data?.Data?.WhatsAppGroupLink;

        if (link) {
            console.log(`[Async] Sending link to ${to}`);
            await axios.post(`https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`, {
                messaging_product: "whatsapp",
                to: to,
                type: "text",
                text: { body: `Welcome to ABTYP 🙏\n\nYour Link:\n${link}` }
            }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
        }
    } catch (e) {
        console.error("[Async] Send Error:", e.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 ABTYP Server Live on Port ${PORT}`);
  console.log(`Environment: ${WHATSAPP_TOKEN ? 'Token Ready' : 'MISSING TOKEN'}`);
  console.log(`Private Key: ${PRIVATE_KEY ? 'Loaded' : 'MISSING'}`);
});
