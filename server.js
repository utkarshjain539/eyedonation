const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json());

const ABTYP_HEADERS = { 
    "api-Key": "ABTYP_API_SECRET_KEY_@ABTYP2023#@763^%ggjhg%", 
    "Content-Type": "application/json" 
};

// Ensure no hidden characters in the key
const PRIVATE_KEY = process.env.PRIVATE_KEY?.replace(/\\n/g, "\n").trim();

app.get("/", (req, res) => res.status(200).send("ABTYP Server is Online"));

const encryptResponse = (data, aesKey, iv) => {
    const invIv = Buffer.alloc(iv.length);
    for (let i = 0; i < iv.length; i++) invIv[i] = ~iv[i];
    const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, invIv);
    const body = JSON.stringify(data);
    const enc = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
    return Buffer.concat([enc, cipher.getAuthTag()]).toString("base64");
};

app.post("/", async (req, res) => {
    // 🔍 RAW LOGGING: This will show in your terminal immediately when the phone hits the server
    console.log("--- NEW INCOMING REQUEST ---");
    
    const { encrypted_aes_key, encrypted_flow_data, initial_vector } = req.body;
    
    if (!encrypted_aes_key) {
        console.log("⚠️ Received non-encrypted request (Health Check)");
        return res.status(200).json({ status: "active" });
    }

    let aesKey, requestIv;
    try {
        aesKey = crypto.privateDecrypt({ 
            key: PRIVATE_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, 
            oaepHash: "sha256", mgf1Hash: "sha256" 
        }, Buffer.from(encrypted_aes_key, "base64"));

        const flowBuffer = Buffer.from(encrypted_flow_data, "base64");
        requestIv = Buffer.from(initial_vector, "base64");
        const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);
        decipher.setAuthTag(flowBuffer.slice(-16));
        const decryptedPayload = JSON.parse(Buffer.concat([decipher.update(flowBuffer.slice(0, -16)), decipher.final()]).toString("utf8"));

        const { action, data, screen } = decryptedPayload;
        console.log(`📱 [${action}] Processing Screen: ${screen || 'USER_REG_SCREEN'}`);

        if (action === "ping") {
            return res.status(200).send(encryptResponse({ version: "7.1", data: { status: "active" } }, aesKey, requestIv));
        }

        if (action === "INIT" || action === "data_exchange") {
            const targetScreen = screen || "USER_REG_SCREEN";

            let resp = {
                version: "7.1",
                screen: targetScreen,
                data: { 
                    gender_list: [{id: "Male", title: "Male"}, {id: "Female", title: "Female"}],
                    country_list: [], state_list: [], parishad_list: [], 
                    is_state_enabled: false, is_parishad_enabled: false, can_submit: false 
                }
            };

            // Fetch Data from ABTYP
            try {
                const cRes = await axios.get("https://api.abtyp.org/v0/country", { headers: ABTYP_HEADERS, timeout: 5000 });
                resp.data.country_list = (cRes.data?.Data || []).map(i => ({ id: String(i.Id), title: i.Name }));
                console.log(`✅ Fetched ${resp.data.country_list.length} countries`);
            } catch (apiErr) {
                console.error("❌ ABTYP API Error:", apiErr.message);
            }

            // Load State/Parishad logic
            const cId = data?.country || data?.c_id;
            if (cId) {
                const sRes = await axios.get(`https://api.abtyp.org/v0/state?CountryId=${cId}`, { headers: ABTYP_HEADERS });
                resp.data.state_list = (sRes.data?.Data || []).map(i => ({ id: String(i.Id), title: i.Name }));
                resp.data.is_state_enabled = resp.data.state_list.length > 0;
            }

            const sId = data?.state || data?.s_id;
            if (sId) {
                const pRes = await axios.get(`https://api.abtyp.org/v0/parishad?StateId=${sId}`, { headers: ABTYP_HEADERS });
                resp.data.parishad_list = (pRes.data?.Data || []).map(i => ({ id: String(i.Id), title: i.Name }));
                resp.data.is_parishad_enabled = resp.data.parishad_list.length > 0;
            }
            
            if (data?.parishad || data?.p_id) resp.data.can_submit = true;

            const base64Body = encryptResponse(resp, aesKey, requestIv);
            console.log("📤 Sending Base64 Response back to Phone...");
            return res.status(200).send(base64Body);
        }

        if (action === "complete") {
            const ack = encryptResponse({ version: "7.1", data: { acknowledged: true } }, aesKey, requestIv);
            return res.status(200).send(ack);
        }

    } catch (err) {
        console.error("🔴 Fatal Error:", err.message);
        return res.status(200).send("error");
    }
});

const PORT = process.env.PORT || 3004;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Linux Server listening on port ${PORT}`));
