const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json());

const ABTYP_HEADERS = { 
    "api-Key": "ABTYP_API_SECRET_KEY_@ABTYP2023#@763^%ggjhg%", 
    "Content-Type": "application/json" 
};

const PRIVATE_KEY = process.env.PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
let cachedCountries = null;

app.get("/", (req, res) => res.status(200).send("ABTYP Flow Server is Awake"));

const encryptResponse = (data, aesKey, iv) => {
    const invIv = Buffer.alloc(iv.length);
    for (let i = 0; i < iv.length; i++) invIv[i] = ~iv[i];
    const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, invIv);
    const body = JSON.stringify(data);
    const enc = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
    return Buffer.concat([enc, cipher.getAuthTag()]).toString("base64");
};

app.post("/", async (req, res) => {
    // 1. Log the incoming raw request (to see if Meta is even hitting the server)
    console.log("--- 📥 NEW REQUEST RECEIVED ---");
    const { encrypted_aes_key, encrypted_flow_data, initial_vector } = req.body;
    
    if (!encrypted_aes_key) {
        console.log("⚠️ Meta Health Check (Ping) detected.");
        return res.status(200).json({ status: "active" });
    }

    let aesKey, requestIv;
    try {
        // 2. Log Decryption Start
        console.log("🔐 Attempting to decrypt AES key...");
        aesKey = crypto.privateDecrypt({ 
            key: PRIVATE_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, 
            oaepHash: "sha256", mgf1Hash: "sha256" 
        }, Buffer.from(encrypted_aes_key, "base64"));

        const flowBuffer = Buffer.from(encrypted_flow_data, "base64");
        requestIv = Buffer.from(initial_vector, "base64");
        const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);
        decipher.setAuthTag(flowBuffer.slice(-16));
        
        const decryptedPayload = JSON.parse(
            Buffer.concat([decipher.update(flowBuffer.slice(0, -16)), decipher.final()]).toString("utf8")
        );

        const { action, data, screen } = decryptedPayload;
        
        // 3. Log the Decrypted Content (Crucial for debugging missing data)
        console.log(`📱 ACTION: ${action} | SCREEN: ${screen}`);
        console.log(`📦 PAYLOAD DATA:`, JSON.stringify(data));

        if (action === "ping") {
            console.log("✅ Ping successful.");
            return res.status(200).send(encryptResponse({ version: "7.1", data: { status: "active" } }, aesKey, requestIv));
        }

        if (action === "INIT" || action === "data_exchange") {
            console.log(`⚙️ Processing ${action}...`);
            
            let resp = {
                version: "7.1",
                screen: screen || "USER_REG_SCREEN",
                data: { 
                    gender_list: [{id: "Male", title: "Male"}, {id: "Female", title: "Female"}],
                    country_list: [], state_list: [], parishad_list: [], 
                    is_state_enabled: false, is_parishad_enabled: false, can_submit: false 
                }
            };

            // 4. Log API Calls
            try {
                console.log("🌐 Calling ABTYP Country API...");
                const cRes = await axios.get("https://api.abtyp.org/v0/country", { headers: ABTYP_HEADERS, timeout: 5000 });
                resp.data.country_list = (cRes.data?.Data || []).map(i => ({ id: String(i.Id), title: i.Name }));
                console.log(`✅ Found ${resp.data.country_list.length} countries.`);
            } catch (e) {
                console.error("❌ Country API Failed:", e.message);
            }

            // (Repeat logic for State/Parishad with logs)
            const selCountry = data?.country || data?.c_id;
            if (selCountry) {
                console.log(`🌐 Calling State API for Country: ${selCountry}`);
                const sRes = await axios.get(`https://api.abtyp.org/v0/state?CountryId=${selCountry}`, { headers: ABTYP_HEADERS });
                resp.data.state_list = (sRes.data?.Data || []).map(i => ({ id: String(i.Id), title: i.Name }));
                resp.data.is_state_enabled = resp.data.state_list.length > 0;
                console.log(`✅ Found ${resp.data.state_list.length} states.`);
            }

            // 5. Log the Final Response (Before Encryption)
            console.log("📤 Final Response Data (unencrypted):", JSON.stringify(resp.data));
            
            const encryptedBody = encryptResponse(resp, aesKey, requestIv);
            console.log("🚀 Encrypted response sent.");
            return res.status(200).send(encryptedBody);
        }

    } catch (err) {
        console.error("🔴 SERVER CRASHED:", err.stack);
        return res.status(200).send("error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Render Server Live on ${PORT}`));
