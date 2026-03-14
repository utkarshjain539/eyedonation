const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const app = express();
app.use(express.json());

const ABTYP_HEADERS = { "api-Key": "ABTYP_API_SECRET_KEY_@ABTYP2023#@763^%ggjhg%", "Content-Type": "application/json" };
const PRIVATE_KEY = process.env.PRIVATE_KEY?.replace(/\\n/g, "\n");
let cachedCountries = null;

const encryptResponse = (data, aesKey, iv) => {
  const invIv = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) invIv[i] = ~iv[i];
  const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, invIv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return Buffer.concat([enc, cipher.getAuthTag()]).toString("base64");
};

app.post("/", async (req, res) => {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = req.body;
  
  // If no encrypted key, it's just a health check from Meta
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

    // 2. Decrypt Flow Data
    const flowBuffer = Buffer.from(encrypted_flow_data, "base64");
    requestIv = Buffer.from(initial_vector, "base64");
    const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, requestIv);
    decipher.setAuthTag(flowBuffer.slice(-16));
    const decryptedPayload = JSON.parse(Buffer.concat([decipher.update(flowBuffer.slice(0, -16)), decipher.final()]).toString("utf8"));

    const { action, data, flow_token, screen } = decryptedPayload;
    console.log(`📱 ACTION: ${action} | TOKEN: ${flow_token}`);

    // Identify Flow
    const isDeathFlow = flow_token && flow_token.toLowerCase().includes("death");

    if (action === "ping") return res.status(200).send(encryptResponse({ version: "7.1", data: { status: "active" } }, aesKey, requestIv));

    if (action === "INIT" || action === "data_exchange") {
      
      // Safety: Define variables with fallback to null
      const selectedCountry = data?.c_id || null;
      const selectedState = data?.s_id || null;
      const selectedParishad = data?.p_id || null;

      // Handle Screen Jump
      if (data?.action === "GO_TO_DETAILS") {
        return res.status(200).send(encryptResponse({
          version: "7.1",
          screen: "DEATH_DETAILS_SCREEN",
          data: {
            prev_data: { 
                name: data.full_name || "", 
                mobile: data.mobile || "", 
                age: data.age || "", 
                gender: data.gender || "", 
                p_id: selectedParishad 
            }
          }
        }, aesKey, requestIv));
      }

      let resp = {
        version: "7.1",
        screen: isDeathFlow ? "DEATH_INFO_SCREEN" : "LOCATION_SCREEN",
        data: { country_list: [], state_list: [], parishad_list: [], is_state_enabled: false, is_parishad_enabled: false, can_move_next: false }
      };

      if (isDeathFlow) {
        resp.data.gender_list = [{id: "Male", title: "Male"}, {id: "Female", title: "Female"}];
      }

      // Fetch Countries
      if (!cachedCountries) {
        const cRes = await axios.get("https://api.abtyp.org/v0/country", { headers: ABTYP_HEADERS });
        cachedCountries = (cRes.data?.Data || []).map(i => ({ id: i.Id.toString(), title: i.Name }));
      }
      resp.data.country_list = cachedCountries;

      // Fetch States only if c_id exists
      if (selectedCountry) {
        const sRes = await axios.get(`https://api.abtyp.org/v0/state?CountryId=${selectedCountry}`, { headers: ABTYP_HEADERS });
        resp.data.state_list = (sRes.data?.Data || []).map(i => ({ id: i.Id.toString(), title: i.Name }));
        resp.data.is_state_enabled = resp.data.state_list.length > 0;
      }

      // Fetch Parishad only if s_id exists
      if (selectedState) {
        const pRes = await axios.get(`https://api.abtyp.org/v0/parishad?StateId=${selectedState}`, { headers: ABTYP_HEADERS });
        resp.data.parishad_list = (pRes.data?.Data || []).map(i => ({ id: i.Id.toString(), title: i.Name }));
        resp.data.is_parishad_enabled = resp.data.parishad_list.length > 0;
      }
      
      if (selectedParishad) resp.data.can_move_next = true;

      return res.status(200).send(encryptResponse(resp, aesKey, requestIv));
    }

    if (action === "complete") {
      return res.status(200).send(encryptResponse({ version: "7.1", data: { acknowledged: true } }, aesKey, requestIv));
    }

  } catch (err) {
    console.error("🔴 Server Error:", err.message);
    
    // 🎯 CRITICAL: Even on error, we must return a 200 Encrypted response if possible, 
    // or at least a 200 OK to prevent the "Base64" error in the UI.
    return res.status(200).send("error"); 
  }
});

app.listen(3000, () => console.log("🚀 Server Live"));
