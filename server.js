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

console.log("=" .repeat(50));
console.log("PRIVATE KEY DEBUG INFO:");
console.log("Private key length:", privateKeyInput.length);
console.log("Private key starts with:", privateKeyInput.substring(0, 50));
console.log("Contains BEGIN PRIVATE KEY:", privateKeyInput.includes("BEGIN PRIVATE KEY"));
console.log("=" .repeat(50));

// Format the private key properly
let formattedKey;
try {
  if (privateKeyInput.includes("BEGIN PRIVATE KEY")) {
    // If it already has headers, just ensure newlines are correct
    formattedKey = privateKeyInput.replace(/\\n/g, "\n").trim();
  } else {
    // If it's just the base64 content, add headers and format
    const cleanKey = privateKeyInput.replace(/\s+/g, '').trim();
    // Split into 64-character lines
    const keyLines = cleanKey.match(/.{1,64}/g) || [];
    formattedKey = `-----BEGIN PRIVATE KEY-----\n${keyLines.join('\n')}\n-----END PRIVATE KEY-----\n`;
  }
  console.log("Private key formatted successfully");
} catch (err) {
  console.error("Error formatting private key:", err);
  formattedKey = privateKeyInput;
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
  // Handle WhatsApp webhook verification
  if (req.body.object) {
    return res.status(200).send("EVENT_RECEIVED");
  }

  const {
    encrypted_aes_key,
    encrypted_flow_data,
    initial_vector
  } = req.body;

  console.log("\n" + "=" .repeat(50));
  console.log("NEW FLOW REQUEST RECEIVED");
  console.log("Time:", new Date().toISOString());
  console.log("Has encrypted_aes_key:", !!encrypted_aes_key);
  console.log("Has encrypted_flow_data:", !!encrypted_flow_data);
  console.log("Has initial_vector:", !!initial_vector);

  // Handle ping/health check
  if (!encrypted_aes_key) {
    console.log("PING REQUEST - Returning OK");
    return res.status(200).send("OK");
  }

  try {
    /* ---------- DECRYPT AES KEY ---------- */
    console.log("Attempting to decrypt AES key...");
    
    let aesKey;
    try {
      const encryptedKeyBuffer = Buffer.from(encrypted_aes_key, "base64");
      console.log("Encrypted AES key length:", encryptedKeyBuffer.length);
      
      aesKey = crypto.privateDecrypt(
        {
          key: formattedKey,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256"
        },
        encryptedKeyBuffer
      );
      
      console.log("AES key decrypted successfully, length:", aesKey.length);
    } catch (decryptErr) {
      console.error("PRIVATE KEY DECRYPTION FAILED:", decryptErr.message);
      console.error("This usually means the private key doesn't match the public key uploaded to WhatsApp");
      
      // Instead of returning "OK", return a valid encrypted response
      // But we need the AES key to encrypt, so we'll create a dummy one
      // This is a fallback that should never happen in production
      const dummyResponse = {
        version: "3.0",
        screen: "LOCATION_SCREEN",
        data: {
          country_list: [],
          state_list: [],
          parishad_list: [],
          is_state_enabled: false,
          is_parishad_enabled: false
        }
      };
      
      // Create a dummy AES key (this won't work for decryption but will allow us to return encrypted data)
      const dummyAesKey = crypto.randomBytes(16);
      const dummyIv = Buffer.from(initial_vector || crypto.randomBytes(12), "base64");
      
      const cipher = crypto.createCipheriv("aes-128-gcm", dummyAesKey, dummyIv);
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(dummyResponse), "utf8"),
        cipher.final()
      ]);
      const authTag = cipher.getAuthTag();
      const finalResponse = Buffer.concat([encrypted, authTag]);
      
      console.log("Returning fallback encrypted response");
      return res.status(200).send(finalResponse.toString("base64"));
    }

    const requestIv = Buffer.from(initial_vector, "base64");
    console.log("Request IV length:", requestIv.length);
    
    // Create response IV by inverting request IV (bitwise NOT)
    const responseIv = Buffer.alloc(requestIv.length);
    for (let i = 0; i < requestIv.length; i++) {
      responseIv[i] = ~requestIv[i];
    }

    /* ---------- DECRYPT PAYLOAD ---------- */
    console.log("Decrypting flow data...");
    const flowBuffer = Buffer.from(encrypted_flow_data, "base64");
    console.log("Flow buffer length:", flowBuffer.length);
    
    // The last 16 bytes are the auth tag
    const authTag = flowBuffer.slice(-16);
    const encryptedData = flowBuffer.slice(0, -16);
    console.log("Auth tag length:", authTag.length);
    console.log("Encrypted data length:", encryptedData.length);

    const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);
    decipher.setAuthTag(authTag);
    
    const decrypted = Buffer.concat([
      decipher.update(encryptedData),
      decipher.final()
    ]).toString("utf8");

    console.log("Decrypted payload:", decrypted);
    
    const decryptedPayload = JSON.parse(decrypted);
    const { action, data } = decryptedPayload;
    
    console.log("Action:", action);
    if (data) console.log("Data:", JSON.stringify(data));

    /* ---------------- PING ---------------- */
    if (action === "ping") {
      console.log("Handling PING action");
      
      const responseData = {
        data: {
          status: "active"
        }
      };

      const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);
      const encryptedResponse = Buffer.concat([
        cipher.update(JSON.stringify(responseData), "utf8"),
        cipher.final()
      ]);
      
      const authTag_response = cipher.getAuthTag();
      const finalResponse = Buffer.concat([encryptedResponse, authTag_response]);
      
      console.log("Ping response prepared, length:", finalResponse.length);
      const base64Response = finalResponse.toString("base64");
      console.log("Base64 response length:", base64Response.length);
      
      return res.status(200).send(base64Response);
    }

    /* ---------------- COMPLETE (FLOW SUBMIT) ---------------- */
    if (action === "complete") {
      console.log("Handling COMPLETE action");
      console.log("Complete data:", JSON.stringify(data));
      
      // Send WhatsApp message asynchronously (fire and forget)
      const parishadId = data?.parishad_id;
      console.log("Parishad ID for group link:", parishadId);
      
      if (parishadId) {
        // Don't await - let it run in background
        axios.get(
          `https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${parishadId}`,
          { headers: ABTYP_HEADERS, timeout: 5000 }
        ).then(linkRes => {
          console.log("Group link API response status:", linkRes.status);
          const groupLink = linkRes.data?.Data?.WhatsAppGroupLink;
          console.log("Group link found:", !!groupLink);
          
          if (groupLink) {
            console.log("Sending WhatsApp message to:", FIXED_RECIPIENT);
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
                },
                timeout: 5000
              }
            ).then(waRes => {
              console.log("WhatsApp message sent successfully:", waRes.status);
            }).catch(waErr => {
              console.error("WhatsApp API error:", waErr.response?.data || waErr.message);
            });
          }
        }).catch(err => {
          console.error("Group link fetch error:", err.response?.data || err.message);
        });
      }

      // Respond to flow immediately
      const responseData = {
        data: {
          acknowledged: true
        }
      };

      const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);
      const encryptedResponse = Buffer.concat([
        cipher.update(JSON.stringify(responseData), "utf8"),
        cipher.final()
      ]);
      
      const authTag_response = cipher.getAuthTag();
      const finalResponse = Buffer.concat([encryptedResponse, authTag_response]);
      
      console.log("Complete response prepared");
      const base64Response = finalResponse.toString("base64");
      
      return res.status(200).send(base64Response);
    }

    /* ---------------- DROPDOWN DATA (DATA_EXCHANGE) ---------------- */
    console.log("Handling DATA_EXCHANGE action");
    
    let responseData = {
      country_list: [],
      state_list: [],
      parishad_list: [],
      is_state_enabled: false,
      is_parishad_enabled: false
    };

    // Fetch countries
    try {
      console.log("Fetching countries...");
      const countryRes = await axios.get(
        "https://api.abtyp.org/v0/country",
        { headers: ABTYP_HEADERS, timeout: 5000 }
      );
      console.log("Countries fetched, status:", countryRes.status);
      responseData.country_list = mapList(countryRes.data?.Data);
      console.log("Country count:", responseData.country_list.length);
    } catch (err) {
      console.error("Country fetch error:", err.message);
    }

    // Fetch states if country selected
    if (data?.country_id) {
      try {
        console.log("Fetching states for country:", data.country_id);
        const stateRes = await axios.get(
          `https://api.abtyp.org/v0/state?CountryId=${data.country_id}`,
          { headers: ABTYP_HEADERS, timeout: 5000 }
        );
        console.log("States fetched, status:", stateRes.status);
        responseData.state_list = mapList(stateRes.data?.Data);
        responseData.is_state_enabled = responseData.state_list.length > 0;
        console.log("State count:", responseData.state_list.length);
      } catch (err) {
        console.error("State fetch error:", err.message);
      }
    }

    // Fetch parishads if state selected
    if (data?.state_id) {
      try {
        console.log("Fetching parishads for state:", data.state_id);
        const parishadRes = await axios.get(
          `https://api.abtyp.org/v0/parishad?StateId=${data.state_id}`,
          { headers: ABTYP_HEADERS, timeout: 5000 }
        );
        console.log("Parishads fetched, status:", parishadRes.status);
        responseData.parishad_list = mapList(parishadRes.data?.Data);
        responseData.is_parishad_enabled = responseData.parishad_list.length > 0;
        console.log("Parishad count:", responseData.parishad_list.length);
      } catch (err) {
        console.error("Parishad fetch error:", err.message);
      }
    }

    // Prepare response for flow
    const flowResponse = {
      version: "3.0",
      screen: "LOCATION_SCREEN",
      data: responseData
    };

    console.log("Sending flow response with data");
    console.log("Response data:", JSON.stringify(responseData));

    // Encrypt response
    const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);
    const encryptedResponse = Buffer.concat([
      cipher.update(JSON.stringify(flowResponse), "utf8"),
      cipher.final()
    ]);
    
    const authTag_response = cipher.getAuthTag();
    const finalResponse = Buffer.concat([encryptedResponse, authTag_response]);
    
    const base64Response = finalResponse.toString("base64");
    console.log("Encrypted response length:", finalResponse.length);
    console.log("Base64 response length:", base64Response.length);
    console.log("=" .repeat(50));
    
    return res.status(200).send(base64Response);

  } catch (err) {
    console.error("SERVER ERROR:", err);
    console.error("Error stack:", err.stack);
    
    // Even on error, return a valid encrypted response if possible
    try {
      // If we have the necessary components, try to encrypt a default response
      if (encrypted_aes_key && initial_vector) {
        const requestIv = Buffer.from(initial_vector, "base64");
        const responseIv = Buffer.alloc(requestIv.length);
        for (let i = 0; i < requestIv.length; i++) {
          responseIv[i] = ~requestIv[i];
        }
        
        // Try to get the AES key again
        const aesKey = crypto.privateDecrypt(
          {
            key: formattedKey,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: "sha256"
          },
          Buffer.from(encrypted_aes_key, "base64")
        );
        
        const errorResponse = {
          version: "3.0",
          screen: "LOCATION_SCREEN",
          data: {
            country_list: [],
            state_list: [],
            parishad_list: [],
            is_state_enabled: false,
            is_parishad_enabled: false
          }
        };
        
        const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);
        const encrypted = Buffer.concat([
          cipher.update(JSON.stringify(errorResponse), "utf8"),
          cipher.final()
        ]);
        const authTag = cipher.getAuthTag();
        const finalResponse = Buffer.concat([encrypted, authTag]);
        
        console.log("Returning error recovery response");
        return res.status(200).send(finalResponse.toString("base64"));
      }
    } catch (e) {
      console.error("Failed to create error recovery response:", e.message);
    }
    
    // Last resort - return a simple OK (this will still fail for flows but better than crashing)
    return res.status(200).send("OK");
  }
});

/* ---------------- START SERVER ---------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("\n" + "=" .repeat(50));
  console.log(`🚀 ABTYP WhatsApp Flow Server Running on port ${PORT}`);
  console.log(`Flow ID: ${FLOW_ID}`);
  console.log(`Server URL: http://localhost:${PORT}`);
  console.log("=" .repeat(50) + "\n");
});
