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

const privateKeyInput = process.env.PRIVATE_KEY || "";

console.log("Private key length:", privateKeyInput.length);
console.log("Private key starts with:", privateKeyInput.substring(0, 30) + "...");
console.log("Contains BEGIN PRIVATE KEY:", privateKeyInput.includes("BEGIN PRIVATE KEY"));

let formattedKey;
try {
  if (privateKeyInput.includes("BEGIN PRIVATE KEY")) {
    // If it already has headers, ensure newlines are correct
    formattedKey = privateKeyInput.replace(/\\n/g, "\n").trim();
  } else {
    // If it's just the key content, add headers and ensure proper formatting
    const cleanedKey = privateKeyInput.replace(/\s+/g, '').match(/.{1,64}/g).join('\n');
    formattedKey = `-----BEGIN PRIVATE KEY-----\n${cleanedKey}\n-----END PRIVATE KEY-----\n`;
  }
  
  console.log("Formatted key length:", formattedKey.length);
  console.log("Formatted key first line:", formattedKey.split('\n')[0]);
} catch (err) {
  console.error("Error formatting key:", err);
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
  // Handle WhatsApp webhook verification
  if (req.body.object) {
    return res.status(200).send("EVENT_RECEIVED");
  }

  const {
    encrypted_aes_key,
    encrypted_flow_data,
    initial_vector
  } = req.body;

  console.log("Received request:", { 
    has_encrypted_aes_key: !!encrypted_aes_key,
    has_encrypted_flow_data: !!encrypted_flow_data,
    has_initial_vector: !!initial_vector
  });

  // Handle ping/health check
  if (!encrypted_aes_key) {
    console.log("Ping request - returning OK");
    return res.status(200).send("OK");
  }

  try {
    console.log("Attempting to decrypt AES key...");
    
    /* ---------- DECRYPT AES KEY ---------- */
    let aesKey;
    try {
      aesKey = crypto.privateDecrypt(
        {
          key: formattedKey,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256"
        },
        Buffer.from(encrypted_aes_key, "base64")
      );
      console.log("AES key decrypted successfully, length:", aesKey.length);
    } catch (decryptErr) {
      console.error("Private key decryption failed:", decryptErr.message);
      console.error("Error code:", decryptErr.code);
      console.error("Error library:", decryptErr.library);
      
      // Return a more helpful error
      return res.status(200).json({ 
        error: "Private key decryption failed. Please check your private key configuration.",
        details: decryptErr.message
      });
    }

    const requestIv = Buffer.from(initial_vector, "base64");
    console.log("Request IV length:", requestIv.length);
    
    // Create response IV by inverting request IV
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

    console.log("Decrypted payload:", decrypted.substring(0, 100) + "...");
    
    const decryptedPayload = JSON.parse(decrypted);
    const { action, data } = decryptedPayload;
    
    console.log("Action:", action);

    /* ---------------- PING ---------------- */
    if (action === "ping") {
      console.log("Handling ping action");
      
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
      return res.status(200).send(finalResponse.toString("base64"));
    }

    /* ---------------- COMPLETE (FLOW SUBMIT) ---------------- */
    if (action === "complete") {
      console.log("Handling complete action");
      console.log("Complete data:", JSON.stringify(data));
      
      // Send WhatsApp message asynchronously
      const parishadId = data?.parishad_id;
      console.log("Parishad ID:", parishadId);
      
      if (parishadId) {
        console.log("Fetching group link for parishad:", parishadId);
        
        axios.get(
          `https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${parishadId}`,
          { headers: ABTYP_HEADERS, timeout: 5000 }
        ).then(linkRes => {
          console.log("Group link API response status:", linkRes.status);
          const groupLink = linkRes.data?.Data?.WhatsAppGroupLink;
          console.log("Group link:", groupLink ? "Found" : "Not found");
          
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
      return res.status(200).send(finalResponse.toString("base64"));
    }

    /* ---------------- DROPDOWN DATA ---------------- */
    console.log("Handling data exchange action");
    console.log("Request data:", JSON.stringify(data));
    
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
    
    // Encrypt response
    const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, responseIv);
    const encryptedResponse = Buffer.concat([
      cipher.update(JSON.stringify(flowResponse), "utf8"),
      cipher.final()
    ]);
    
    const authTag_response = cipher.getAuthTag();
    const finalResponse = Buffer.concat([encryptedResponse, authTag_response]);
    
    return res.status(200).send(finalResponse.toString("base64"));

  } catch (err) {
    console.error("Server error:", err);
    console.error("Error stack:", err.stack);
    
    return res.status(200).json({ 
      error: "Server error occurred",
      message: err.message
    });
  }
});

/* ---------------- START SERVER ---------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 ABTYP WhatsApp Flow Server Running on port ${PORT}`);
  console.log(`Flow ID: ${FLOW_ID}`);
  console.log("Environment variables check:");
  console.log("- PRIVATE_KEY set:", !!process.env.PRIVATE_KEY);
});
