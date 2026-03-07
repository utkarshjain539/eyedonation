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

let formattedKey;
if (privateKeyInput.includes("BEGIN PRIVATE KEY")) {
  formattedKey = privateKeyInput.replace(/\\n/g, "\n");
} else {
  formattedKey = `-----BEGIN PRIVATE KEY-----\n${privateKeyInput}\n-----END PRIVATE KEY-----`;
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

  // Handle ping/health check
  if (!encrypted_aes_key) {
    return res.status(200).send("OK");
  }

  try {
    /* ---------- DECRYPT AES KEY ---------- */
    const aesKey = crypto.privateDecrypt(
      {
        key: formattedKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256"
      },
      Buffer.from(encrypted_aes_key, "base64")
    );

    const requestIv = Buffer.from(initial_vector, "base64");
    
    // Create response IV by inverting request IV
    const responseIv = Buffer.alloc(requestIv.length);
    for (let i = 0; i < requestIv.length; i++) {
      responseIv[i] = ~requestIv[i];
    }

    /* ---------- DECRYPT PAYLOAD ---------- */
    const flowBuffer = Buffer.from(encrypted_flow_data, "base64");
    
    // The last 16 bytes are the auth tag
    const authTag = flowBuffer.slice(-16);
    const encryptedData = flowBuffer.slice(0, -16);

    const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);
    decipher.setAuthTag(authTag);
    
    const decrypted = Buffer.concat([
      decipher.update(encryptedData),
      decipher.final()
    ]).toString("utf8");

    const decryptedPayload = JSON.parse(decrypted);
    const { action, data } = decryptedPayload;

    /* ---------------- PING ---------------- */
    if (action === "ping") {
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
      
      // Get auth tag and combine
      const authTag_response = cipher.getAuthTag();
      const finalResponse = Buffer.concat([encryptedResponse, authTag_response]);
      
      return res.status(200).send(finalResponse.toString("base64"));
    }

    /* ---------------- COMPLETE (FLOW SUBMIT) ---------------- */
    if (action === "complete") {
      // Send WhatsApp message asynchronously
      const parishadId = data?.parishad_id;
      
      if (parishadId) {
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

      // Respond to flow
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
      
      return res.status(200).send(finalResponse.toString("base64"));
    }

    /* ---------------- DROPDOWN DATA ---------------- */
    let responseData = {
      country_list: [],
      state_list: [],
      parishad_list: [],
      is_state_enabled: false,
      is_parishad_enabled: false
    };

    // Fetch countries
    try {
      const countryRes = await axios.get(
        "https://api.abtyp.org/v0/country",
        { headers: ABTYP_HEADERS, timeout: 5000 }
      );
      responseData.country_list = mapList(countryRes.data?.Data);
    } catch (err) {
      console.error("Country fetch error:", err.message);
    }

    // Fetch states if country selected
    if (data?.country_id) {
      try {
        const stateRes = await axios.get(
          `https://api.abtyp.org/v0/state?CountryId=${data.country_id}`,
          { headers: ABTYP_HEADERS, timeout: 5000 }
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
          { headers: ABTYP_HEADERS, timeout: 5000 }
        );
        responseData.parishad_list = mapList(parishadRes.data?.Data);
        responseData.is_parishad_enabled = responseData.parishad_list.length > 0;
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
    console.error("Server error:", err.message);
    
    // Even on error, return a valid encrypted response
    try {
      // Recreate responseIv if we have the requestIv
      if (initial_vector) {
        const requestIv = Buffer.from(initial_vector, "base64");
        const responseIv = Buffer.alloc(requestIv.length);
        for (let i = 0; i < requestIv.length; i++) {
          responseIv[i] = ~requestIv[i];
        }
        
        // Get aesKey again if we have encrypted_aes_key
        if (encrypted_aes_key) {
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
          const encryptedResponse = Buffer.concat([
            cipher.update(JSON.stringify(errorResponse), "utf8"),
            cipher.final()
          ]);
          
          const authTag_response = cipher.getAuthTag();
          const finalResponse = Buffer.concat([encryptedResponse, authTag_response]);
          
          return res.status(200).send(finalResponse.toString("base64"));
        }
      }
    } catch (e) {
      // If all else fails
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
