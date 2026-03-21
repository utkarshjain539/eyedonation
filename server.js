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
    const { encrypted_aes_key, encrypted_flow_data, initial_vector } = req.body;
    if (!encrypted_aes_key) return res.status(200).json({ status: "active" });

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
        console.log(`📱 ACTION: ${action} | SCREEN: ${screen}`);

        if (action === "ping") {
            return res.status(200).send(encryptResponse({ version: "7.1", data: { status: "active" } }, aesKey, requestIv));
        }

        if (action === "INIT" || action === "data_exchange") {
            // Force the target screen to match your Flow JSON ID
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

            // 1. Get Countries
            if (!cachedCountries) {
                const cRes = await axios.get("https://api.abtyp.org/v0/country", { headers: ABTYP_HEADERS });
                cachedCountries = (cRes.data?.Data || []).map(i => ({ id: String(i.Id), title: i.Name }));
            }
            resp.data.country_list = cachedCountries;

            // 2. Get States (Checks BOTH 'country' and 'c_id' to be safe)
            const selCountry = data?.country || data?.c_id;
            if (selCountry) {
                const sRes = await axios.get(`https://api.abtyp.org/v0/state?CountryId=${selCountry}`, { headers: ABTYP_HEADERS });
                resp.data.state_list = (sRes.data?.Data || []).map(i => ({ id: String(i.Id), title: i.Name }));
                resp.data.is_state_enabled = resp.data.state_list.length > 0;
            }

            // 3. Get Parishads (Checks BOTH 'state' and 's_id' to be safe)
            const selState = data?.state || data?.s_id;
            if (selState) {
                const pRes = await axios.get(`https://api.abtyp.org/v0/parishad?StateId=${selState}`, { headers: ABTYP_HEADERS });
                resp.data.parishad_list = (pRes.data?.Data || []).map(i => ({ id: String(i.Id), title: i.Name }));
                resp.data.is_parishad_enabled = resp.data.parishad_list.length > 0;
            }
            
            if (data?.parishad || data?.p_id) resp.data.can_submit = true;

            const base64Res = encryptResponse(resp, aesKey, requestIv);
            return res.status(200).send(base64Res);
        }

        if (action === "complete") {
            return res.status(200).send(encryptResponse({ version: "7.1", data: { acknowledged: true } }, aesKey, requestIv));
        }
    } catch (err) {
        console.error("🔴 Error:", err.message);
        return res.status(200).send("error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Render Server Live on ${PORT}`));
