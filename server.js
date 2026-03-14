const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const app = express();
app.use(express.json());

// --- CONFIGURATION ---
const ABTYP_HEADERS = { 
    "api-Key": "ABTYP_API_SECRET_KEY_@ABTYP2023#@763^%ggjhg%", 
    "Content-Type": "application/json" 
};
const PRIVATE_KEY = process.env.PRIVATE_KEY?.replace(/\\n/g, "\n");
let cachedCountries = null;

// Browser Health Check
app.get("/", (req, res) => {
    res.status(200).json({ status: "active", message: "ABTYP Dual Flow Server Ready" });
});

// Encryption Helper
const encryptResponse = (data, aesKey, iv) => {
    const invIv = Buffer.alloc(iv.length);
    for (let i = 0; i < iv.length; i++) invIv[i] = ~iv[i];
    const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, invIv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
    return Buffer.concat([enc, cipher.getAuthTag()]).toString("base64");
};

app.post("/", async (req, res) => {
    const { encrypted_aes_key, encrypted_flow_data, initial_vector } = req.body;
    
    // Meta Health Check
    if (!encrypted_aes_key) return res.status(200).json({ status: "active" });

    try {
        // 1. Decrypt AES Key
        const aesKey = crypto.privateDecrypt({ 
            key: PRIVATE_KEY, 
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, 
            oaepHash: "sha256", 
            mgf1Hash: "sha256" 
        }, Buffer.from(encrypted_aes_key, "base64"));

        // 2. Decrypt Flow Data
        const flowBuffer = Buffer.from(encrypted_flow_data, "base64");
        const requestIv = Buffer.from(initial_vector, "base64");
        const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);
        decipher.setAuthTag(flowBuffer.slice(-16));
        const decryptedPayload = JSON.parse(Buffer.concat([decipher.update(flowBuffer.slice(0, -16)), decipher.final()]).toString("utf8"));

        const { action, data, flow_token, screen } = decryptedPayload;

        // 🎯 LOGIC: IDENTIFY WHICH FLOW IS CALLING
        // We check the token OR the current screen ID to avoid "Unexpected Screen" errors.
       const isDeathFlow = (flow_token && flow_token.toLowerCase().includes("death")) || 
                    (decryptedPayload.screen && decryptedPayload.screen.includes("DEATH_REG"));

console.log(`📱 LOG: Screen Received from Phone: ${decryptedPayload.screen}`);
console.log(`📱 LOG: Token Received: ${flow_token}`);
console.log(`📱 LOG: Calculated isDeathFlow: ${isDeathFlow}`);
        console.log(`📱 [${action}] Flow: ${isDeathFlow ? 'DEATH' : 'LOCATION'} | Screen: ${screen}`);

        // 3. Handle Ping
        if (action === "ping") {
            return res.status(200).send(encryptResponse({ version: "7.1", data: { status: "active" } }, aesKey, requestIv));
        }

        // 4. Handle Logic (INIT & DATA_EXCHANGE)
        if (action === "INIT" || action === "data_exchange") {
            
            // --- DEATH FLOW: HANDLE SCREEN JUMP ---
            if (isDeathFlow && data?.action === "GO_TO_DETAILS") {
                return res.status(200).send(encryptResponse({
                    version: "7.1",
                    screen: "DEATH_REG_SCREEN_TWO",
                    data: {
                        prev_data: { 
                            name: data.full_name, 
                            mobile: data.mobile, 
                            age: data.age, 
                            gender: data.gender, 
                            p_id: data.parishad_id 
                        }
                    }
                }, aesKey, requestIv));
            }

            // --- DEFINE TARGET SCREEN ---
            // This ensures we never send "LOCATION_SCREEN" to the Death Flow
            let targetScreen = "LOCATION_SCREEN"; // Default for existing flow
            if (isDeathFlow) {
                targetScreen = (screen === "DEATH_REG_SCREEN_TWO") ? "DEATH_REG_SCREEN_TWO" : "DEATH_REG_SCREEN_ONE";
            }

            let resp = {
                version: "7.1",
                screen: targetScreen,
                data: { 
                    country_list: [], 
                    state_list: [], 
                    parishad_list: [], 
                    is_state_enabled: false, 
                    is_parishad_enabled: false,
                    can_move_next: false 
                }
            };

            // Add static lists for Death Flow
            if (isDeathFlow && targetScreen === "DEATH_REG_SCREEN_ONE") {
                resp.data.gender_list = [{id: "Male", title: "Male"}, {id: "Female", title: "Female"}];
            }

            // --- SHARED DATA FETCHING (Works for both flows) ---
            if (!cachedCountries) {
                const cRes = await axios.get("https://api.abtyp.org/v0/country", { headers: ABTYP_HEADERS });
                cachedCountries = (cRes.data?.Data || []).map(i => ({ id: i.Id.toString(), title: i.Name }));
            }
            resp.data.country_list = cachedCountries;

            if (data?.c_id) {
                const sRes = await axios.get(`https://api.abtyp.org/v0/state?CountryId=${data.c_id}`, { headers: ABTYP_HEADERS });
                resp.data.state_list = (sRes.data?.Data || []).map(i => ({ id: i.Id.toString(), title: i.Name }));
                resp.data.is_state_enabled = resp.data.state_list.length > 0;
            }

            if (data?.s_id) {
                const pRes = await axios.get(`https://api.abtyp.org/v0/parishad?StateId=${data.s_id}`, { headers: ABTYP_HEADERS });
                resp.data.parishad_list = (pRes.data?.Data || []).map(i => ({ id: i.Id.toString(), title: i.Name }));
                resp.data.is_parishad_enabled = resp.data.parishad_list.length > 0;
            }

            if (data?.p_id) {
                resp.data.can_move_next = true;
            }

            return res.status(200).send(encryptResponse(resp, aesKey, requestIv));
        }

        // 5. Handle Complete
        if (action === "complete") {
            return res.status(200).send(encryptResponse({ version: "7.1", data: { acknowledged: true } }, aesKey, requestIv));
        }

    } catch (err) {
        console.error("🔴 Server Error:", err.message);
        return res.status(200).send("error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Multi-Flow Server Live on Port ${PORT}`));
