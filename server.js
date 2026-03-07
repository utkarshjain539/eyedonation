const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json());

/* ---------------- CONFIG ---------------- */

const ABTYP_HEADERS = {
  "api-Key": "ABTYP_API_SECRET_KEY_@ABTYP2023#@763^%ggjhg%",
  "Content-Type": "application/json"
};

const PHONE_NUMBER_ID = "1049088024951885";
const WHATSAPP_TOKEN = "EAAb2OhvJlfEBQ0W2ZA6NCOzyP81B6g6OBg8pqf8SOVPU2VXSnMbL9vk6AHZBZA2bzAR7cdzcaiWh2SVy3S2zqw6YgiTIXboWKqhqmhMgsXw1Xn2Qw2c1brCya1XQ2M51rWuGN0byNTfwBfHEfpwJPKGbpFp5jYZCYTf2hZBJx2Uf8BTYiQg2waaeAhyKxB2iIB0ZBhrGiDKS5p6fHGUTESZBF9ov6RrXxZAz1pjhKn4IEKx8pvySczskJfgDZCdxEKZCNxpSuuj1UTbTMZCjmuyq0BbCIwQewZDZD";
const FIXED_RECIPIENT = "918488861504";
const FLOW_ID = "787019400633069";

/* ---------------- PRIVATE KEY ---------------- */

// Get private key from environment variable
const privateKeyInput = process.env.PRIVATE_KEY || "";

// Format the private key properly
let formattedKey;
try {
  if (privateKeyInput.includes("BEGIN PRIVATE KEY")) {
    // If it already has headers, just fix newlines
    formattedKey = privateKeyInput.replace(/\\n/g, "\n");
  } else {
    // If it's just the key content, add headers
    formattedKey = `-----BEGIN PRIVATE KEY-----\n${privateKeyInput}\n-----END PRIVATE KEY-----`;
  }
} catch (err) {
  console.error("Error formatting private key:", err);
  formattedKey = "";
}

/* ---------------- UTIL ---------------- */

const mapList = (arr) =>
  (arr || []).map((item) => ({
    id: item.Id?.toString() || "",
    title: item.Name || ""
  }));

/* ---------------- HEALTH CHECK ---------------- */

app.get("/", (req, res) => {
  res.status(200).send("ABTYP WhatsApp Flow Server Running");
});

/* ---------------- FLOW ENDPOINT ---------------- */

app.post("/", async (req, res) => {
  // Always return 200 for WhatsApp webhook verification
  if (req.body.object) {
    return res.status(200).send("EVENT_RECEIVED");
  }

  const {
    encrypted_aes_key,
    encrypted_flow_data,
    initial_vector,
    authentication_tag
  } = req.body;

  // Handle ping/health check from WhatsApp
  if (!encrypted_aes_key) {
    return res.status(200).send("OK");
  }

  try {
    /* ---------- DECRYPT AES KEY ---------- */
    if (!formattedKey) {
      throw new Error("Private key not properly configured");
    }

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
    for (let i = 0; i < requestIv.length; i++) responseIv[i] = ~requestIv[i];

    /* ---------- DECRYPT PAYLOAD ---------- */
    const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);
    const flowBuffer = Buffer.from(encrypted_flow_data, "base64");

    // Handle authentication tag
    let authTag;
    if (authentication_tag) {
      authTag = Buffer.from(authentication_tag, "base64");
    } else {
      authTag = flowBuffer.slice(-16);
    }
    decipher.setAuthTag(authTag);

    // Decrypt the data
    let decrypted;
    if (authentication_tag) {
      decrypted = decipher.update(flowBuffer, "binary", "utf8") + decipher.final("utf8");
    } else {
      decrypted = decipher.update(flowBuffer.slice(0, -16), "binary", "utf8") + decipher.final("utf8");
    }

    const decryptedPayload = JSON.parse(decrypted);
    const { action, data, flow_token } = decryptedPayload;

    /* ---------------- PING ---------------- */
    if (action === "ping") {
      const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify({ 
          data: { status: "active" }
        }), "utf8"),
        cipher.final()
      ]);

      const response = Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64");
      return res.status(200).send(response);
    }

    /* ---------------- COMPLETE (FLOW SUBMIT) ---------------- */
    if (action === "complete") {
      // Send WhatsApp message asynchronously - don't wait for it
      const parishadId = data?.parishad_id;
      
      if (parishadId) {
        // Don't await this - let it run in background
        axios.get(
          `https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${parishadId}`,
          { headers: ABTYP_HEADERS }
        ).then(linkRes => {
          const groupLink = linkRes.data?.Data?.WhatsAppGroupLink;
          if (groupLink) {
            return axios.post(
              `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
              {
                messaging_product: "whatsapp",
                to: FIXED_RECIPIENT,
                type: "text",
                text: {
                  body: `Welcome to ABTYP 🙏\n\nHere is your Parishad WhatsApp Group Link:\n\n${groupLink}`
                }
              },
              {
                headers: {
                  Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                  "Content-Type": "application/json"
                }
              }
            );
          }
        }).catch(err => {
          console.error("Background task error:", err.message);
        });
      }

      // Immediately respond to flow
      const responsePayload = {
        version: "3.0",
        data: { acknowledged: true }
      };

      const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(responsePayload), "utf8"),
        cipher.final()
      ]);

      const response = Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64");
      return res.status(200).send(response);
    }

    /* ---------------- DROPDOWN DATA ---------------- */
    let responseData = {
      country_list: [],
      state_list: [],
      parishad_list: [],
      is_state_enabled: false,
      is_parishad_enabled: false
    };

    // Fetch data in parallel for better performance
    const promises = [];

    // Always fetch countries
    promises.push(
      axios.get("https://api.abtyp.org/v0/country", { headers: ABTYP_HEADERS })
        .then(res => {
          responseData.country_list = mapList(res.data?.Data);
        })
        .catch(err => {
          console.error("Country fetch error:", err.message);
        })
    );

    await Promise.all(promises);

    // Fetch states if country selected
    if (data?.country_id) {
      try {
        const stateRes = await axios.get(
          `https://api.abtyp.org/v0/state?CountryId=${data.country_id}`,
          { headers: ABTYP_HEADERS }
        );
        responseData.state_list = mapList(stateRes.data?.Data);
        responseData.is_state_enabled = responseData.state_list.length > 0;
      } catch (err) {
        console.error("State fetch error:", err.message);
      }
    }

    // Fetch parishads if state selected
    if (data?.state_id) {
      try {
        const parishadRes = await axios.get(
          `https://api.abtyp.org/v0/parishad?StateId=${data.state_id}`,
          { headers: ABTYP_HEADERS }
        );
        responseData.parishad_list = mapList(parishadRes.data?.Data);
        responseData.is_parishad_enabled = responseData.parishad_list.length > 0;
      } catch (err) {
        console.error("Parishad fetch error:", err.message);
      }
    }

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

    const response = Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64");
    return res.status(200).send(response);

  } catch (err) {
    console.error("Server error:", err.message);
    
    // Even on error, return 200 with a basic response
    // This prevents WhatsApp from showing "Failed to load flow"
    try {
      const responsePayload = {
        version: "3.0",
        screen: "LOCATION_SCREEN",
        data: {
          country_list: [],
          state_list: [],
          parishad_list: [],
          is_state_enabled: false,
          is_parishad_enabled: false,
          error: "Unable to load data"
        }
      };
      
      // Try to encrypt if we have the necessary components
      if (aesKey && responseIv) {
        const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);
        const encrypted = Buffer.concat([
          cipher.update(JSON.stringify(responsePayload), "utf8"),
          cipher.final()
        ]);
        const response = Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64");
        return res.status(200).send(response);
      }
    } catch (e) {
      // If encryption fails, send plain response
      return res.status(200).send("OK");
    }
    
    return res.status(200).send("OK");
  }
});

/* ---------------- START SERVER ---------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 ABTYP WhatsApp Flow Server Running on port ${PORT}`);
  console.log(`Flow ID: ${FLOW_ID}`);
});
