const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const app = express();
app.use(express.json());

const ABTYP_HEADERS = { "api-Key": "ABTYP_API_SECRET_KEY_@ABTYP2023#@763^%ggjhg%", "Content-Type": "application/json" };
const PRIVATE_KEY = process.env.PRIVATE_KEY?.replace(/\\n/g, "\n");
let cachedCountries = null;

app.get("/", (req, res) => res.status(200).send("ABTYP All-in-One Server Active"));

const encryptResponse = (data, aesKey, iv) => {
    const invIv = Buffer.alloc(iv.length);
    for (let i = 0; i < iv.length; i++) invIv[i] = ~iv[i];
    const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, invIv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
    return Buffer.concat([enc, cipher.getAuthTag()]).toString("base64");
};

app.post("/", async (req, res) => {
    const { encrypted_aes_key, encrypted_flow_data, initial_vector } = req.body;
    if (!encrypted_aes_key) return res.status(200).json({ status: "active" });

    try {
        const aesKey = crypto.privateDecrypt({ key: PRIVATE_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", mgf1Hash: "sha256" }, Buffer.from(encrypted_aes_key, "base64"));
        const flowBuffer = Buffer.from(encrypted_flow_data, "base64");
        const requestIv = Buffer.from(initial_vector, "base64");
        const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);
        decipher.setAuthTag(flowBuffer.slice(-16));
        const decryptedPayload = JSON.parse(Buffer.concat([decipher.update(flowBuffer.slice(0, -16)), decipher.final()]).toString("utf8"));

       
        if (action === "ping") return res.status(200).send(encryptResponse({ version: "7.1", data: { status: "active" } }, aesKey, requestIv));

       const { action, data, flow_token, screen } = decryptedPayload;
        
        // 🎯 FORCED FLOW IDENTIFICATION
        const isDeath = (flow_token && flow_token.toLowerCase().includes("death")) || 
                        (screen && screen.toLowerCase().includes("death"));

        if (action === "INIT" || action === "data_exchange") {
            // IF it is death flow, we ONLY return DEATH_REG_SINGLE_SCREEN
            // IF it is location flow, we ONLY return LOCATION_SCREEN
            const targetScreen = isDeath ? "DEATH_REG_SINGLE_SCREEN" : "LOCATION_SCREEN";

            let resp = {
                version: "7.1",
                screen: targetScreen,
                data: { 
                    country_list: [], state_list: [], parishad_list: [], 
                    is_state_enabled: false, is_parishad_enabled: false, can_submit: false 
                }
            };

            if (isDeath) resp.data.gender_list = [{id: "Male", title: "Male"}, {id: "Female", title: "Female"}];

            // Shared Data Fetching
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
            if (data?.p_id) resp.data.can_submit = true;

            return res.status(200).send(encryptResponse(resp, aesKey, requestIv));
        }

        if (action === "complete") {
            return res.status(200).send(encryptResponse({ version: "7.1", data: { acknowledged: true } }, aesKey, requestIv));
        }

    } catch (err) {
        return res.status(200).send("error");
    }
});

app.listen(process.env.PORT || 3000);
