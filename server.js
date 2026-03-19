const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json());

const ABTYP_HEADERS = { 
    "api-Key": "ABTYP_API_SECRET_KEY_@ABTYP2023#@763^%ggjhg%", 
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0" // Some Linux servers need this to avoid being blocked
};

const getPrivateKey = () => {
    let key = process.env.PRIVATE_KEY;
    if (!key) return null;
    return key.replace(/\\n/g, "\n").trim();
};

let cachedCountries = null;

const encryptResponse = (data, aesKey, iv) => {
    const invIv = Buffer.alloc(iv.length);
    for (let i = 0; i < iv.length; i++) invIv[i] = ~iv[i];
    const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, invIv);
    const body = JSON.stringify(data);
    const enc = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
    return Buffer.concat([enc, cipher.getAuthTag()]).toString("base64");
};

app.post("/", async (req, res) => {
    const { encrypted_aes_key, encrypted_flow_data, initial_vector } = req.body;
    if (!encrypted_aes_key) return res.status(200).json({ status: "active" });

    let aesKey, requestIv;
    const PRIVATE_KEY = getPrivateKey();

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

        const { action, data } = decryptedPayload;
        console.log(`📱 [${action}] Processing request...`);

        if (action === "INIT" || action === "data_exchange") {
            let resp = {
                version: "7.1",
                screen: "USER_REG_SCREEN",
                data: { 
                    gender_list: [{id: "Male", title: "Male"}, {id: "Female", title: "Female"}],
                    country_list: [], state_list: [], parishad_list: [], 
                    is_state_enabled: false, is_parishad_enabled: false, can_submit: false 
                }
            };

            try {
                // 1. Countries
                if (!cachedCountries) {
                    const cRes = await axios.get("https://api.abtyp.org/v0/country", { headers: ABTYP_HEADERS, timeout: 5000 });
                    cachedCountries = (cRes.data?.Data || []).map(i => ({ id: i.Id.toString(), title: i.Name }));
                }
                resp.data.country_list = cachedCountries;

                // 2. States
                const countryId = data?.country || data?.c_id;
                if (countryId) {
                    const sRes = await axios.get(`https://api.abtyp.org/v0/state?CountryId=${countryId}`, { headers: ABTYP_HEADERS, timeout: 5000 });
                    resp.data.state_list = (sRes.data?.Data || []).map(i => ({ id: i.Id.toString(), title: i.Name }));
                    resp.data.is_state_enabled = resp.data.state_list.length > 0;
                }

                // 3. Parishads
                const stateId = data?.state || data?.s_id;
                if (stateId) {
                    const pRes = await axios.get(`https://api.abtyp.org/v0/parishad?StateId=${stateId}`, { headers: ABTYP_HEADERS, timeout: 5000 });
                    resp.data.parishad_list = (pRes.data?.Data || []).map(i => ({ id: i.Id.toString(), title: i.Name }));
                    resp.data.is_parishad_enabled = resp.data.parishad_list.length > 0;
                }
            } catch (apiErr) {
                console.error("🌐 ABTYP API ERROR:", apiErr.message);
                // Even if API fails, we must return a valid encrypted response so the flow doesn't crash
            }
            
            if (data?.parishad || data?.p_id) resp.data.can_submit = true;

            return res.status(200).send(encryptResponse(resp, aesKey, requestIv));
        }

        if (action === "complete") {
            return res.status(200).send(encryptResponse({ version: "7.1", data: { acknowledged: true } }, aesKey, requestIv));
        }
    } catch (err) {
        console.error("🔴 Server Error:", err.message);
        return res.status(500).send("Decryption/Logic Error");
    }
});

const PORT = process.env.PORT || 3004;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Linux Flow Server on port ${PORT}`));
