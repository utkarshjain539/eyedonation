const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json());

const ABTYP_HEADERS = { 
    "api-Key": "ABTYP_API_SECRET_KEY_@ABTYP2023#@763^%ggjhg%", 
    "Content-Type": "application/json" 
};

// 🛠️ Linux Environment Variable Fix: Handles \n and removes extra whitespace
const PRIVATE_KEY = process.env.PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
let cachedCountries = null;

/**
 * ✅ Root GET Route
 * Prevents "Cannot GET /" and allows health checks
 */
app.get("/", (req, res) => res.status(200).send("🚀 ABTYP Production Flow Server Active"));

/**
 * 🔒 Meta-Compliant Encryption Engine
 * Returns the exact Base64 string required by WhatsApp
 */
const encryptResponse = (data, aesKey, iv) => {
    const invIv = Buffer.alloc(iv.length);
    for (let i = 0; i < iv.length; i++) invIv[i] = ~iv[i]; // Bitwise NOT as per Meta specs
    const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, invIv);
    const body = JSON.stringify(data);
    const enc = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([enc, tag]).toString("base64");
};

/**
 * 🎯 MAIN WEBHOOK ENDPOINT
 */
app.post("/", async (req, res) => {
    const { encrypted_aes_key, encrypted_flow_data, initial_vector } = req.body;
    
    // Initial Health Check from Meta Dashboard
    if (!encrypted_aes_key) return res.status(200).json({ status: "active" });

    let aesKey, requestIv;

    try {
        // 1. Decrypt AES Key
        aesKey = crypto.privateDecrypt({ 
            key: PRIVATE_KEY, 
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, 
            oaepHash: "sha256", 
            mgf1Hash: "sha256" 
        }, Buffer.from(encrypted_aes_key, "base64"));

        const flowBuffer = Buffer.from(encrypted_flow_data, "base64");
        requestIv = Buffer.from(initial_vector, "base64");

        // 2. Decrypt Payload
        const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);
        decipher.setAuthTag(flowBuffer.slice(-16));
        const decryptedPayload = JSON.parse(
            Buffer.concat([decipher.update(flowBuffer.slice(0, -16)), decipher.final()]).toString("utf8")
        );

        const { action, data, flow_token, screen } = decryptedPayload;
        console.log(`📱 ACTION: ${action} | SCREEN: ${screen} | TOKEN: ${flow_token}`);

        // 3. Flow Identification Logic
        const isUserReg = (flow_token?.toLowerCase().includes("reg")) || (screen === "USER_REG_SCREEN");
        const isDeath = (flow_token?.toLowerCase().includes("death")) || (screen === "DEATH_REG_SINGLE_SCREEN");

        if (action === "ping") {
            const result = encryptResponse({ version: "7.1", data: { status: "active" } }, aesKey, requestIv);
            return res.status(200).send(result);
        }

        if (action === "INIT" || action === "data_exchange") {
            // Determine target screen based on the initial flow trigger
            let targetScreen = screen;
            if (action === "INIT") {
                targetScreen = isUserReg ? "USER_REG_SCREEN" : (isDeath ? "DEATH_REG_SINGLE_SCREEN" : "LOCATION_SCREEN");
            }

            let resp = {
                version: "7.1",
                screen: targetScreen,
                data: { 
                    country_list: [], state_list: [], parishad_list: [], 
                    is_state_enabled: false, is_parishad_enabled: false, 
                    can_submit: false, can_move_next: false 
                }
            };

            // Add Gender dropdown for Reg and Death flows
            if (isUserReg || isDeath) {
                resp.data.gender_list = [{id: "Male", title: "Male"}, {id: "Female", title: "Female"}];
            }

            // --- FETCH COUNTRIES ---
            if (!cachedCountries) {
                const cRes = await axios.get("https://api.abtyp.org/v0/country", { headers: ABTYP_HEADERS });
                cachedCountries = (cRes.data?.Data || []).map(i => ({ id: String(i.Id), title: i.Name }));
            }
            resp.data.country_list = cachedCountries;

            // --- FETCH STATES (Handles country or c_id keys) ---
            const selCountry = data?.country || data?.c_id;
            if (selCountry) {
                const sRes = await axios.get(`https://api.abtyp.org/v0/state?CountryId=${selCountry}`, { headers: ABTYP_HEADERS });
                resp.data.state_list = (sRes.data?.Data || []).map(i => ({ id: String(i.Id), title: i.Name }));
                resp.data.is_state_enabled = resp.data.state_list.length > 0;
            }

            // --- FETCH PARISHADS (Handles state or s_id keys) ---
            const selState = data?.state || data?.s_id;
            if (selState) {
                const pRes = await axios.get(`https://api.abtyp.org/v0/parishad?StateId=${selState}`, { headers: ABTYP_HEADERS });
                resp.data.parishad_list = (pRes.data?.Data || []).map(i => ({ id: String(i.Id), title: i.Name }));
                resp.data.is_parishad_enabled = resp.data.parishad_list.length > 0;
            }
            
            // --- ENABLE FOOTER BUTTONS ---
            if (data?.parishad || data?.p_id) {
                resp.data.can_submit = true;
                resp.data.can_move_next = true;
            }

            // Final Encryption and Response
            const encryptedBody = encryptResponse(resp, aesKey, requestIv);
            return res.status(200).send(encryptedBody);
        }

        if (action === "complete") {
            const ack = encryptResponse({ version: "7.1", data: { acknowledged: true } }, aesKey, requestIv);
            return res.status(200).send(ack);
        }

    } catch (err) {
        console.error("🔴 Fatal Error:", err.message);
        if (aesKey && requestIv) {
            const errRes = encryptResponse({ version: "7.1", data: { error: "Service Timeout" } }, aesKey, requestIv);
            return res.status(200).send(errRes);
        }
        return res.status(500).send("Decryption failure. Verify Private Key.");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Linux Flow Server is listening on port ${PORT}`);
});
