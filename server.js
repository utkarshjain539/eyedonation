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
  if (!encrypted_aes_key) return res.status(200).json({ status: "active" });

 try {
    const { action, data, flow_token } = decryptedPayload;
    
    // 🎯 IDENTIFY THE FLOW
    // We check if the token from your PHP template contains "death"
    const isDeathFlow = flow_token && flow_token.toLowerCase().includes("death");

    if (action === "ping") return res.status(200).send(encryptResponse({ version: "7.1", data: { status: "active" } }, aesKey, requestIv));

    if (action === "INIT" || action === "data_exchange") {
      
      // 1. Handle Screen Jump for Death Flow
      if (data?.action === "GO_TO_DETAILS") {
        return res.status(200).send(encryptResponse({
          version: "7.1",
          screen: "DEATH_DETAILS_SCREEN",
          data: {
            prev_data: { name: data.full_name, mobile: data.mobile, age: data.age, gender: data.gender, p_id: data.parishad_id }
          }
        }, aesKey, requestIv));
      }

      // 2. Decide which screen to show based on the Flow
      // This PREVENTS the "Unexpected screen [LOCATION_SCREEN]" error
      let resp = {
        version: "7.1",
        screen: isDeathFlow ? "DEATH_INFO_SCREEN" : "LOCATION_SCREEN", 
        data: { 
          country_list: [], 
          state_list: [], 
          parishad_list: [], 
          is_state_enabled: false, 
          is_parishad_enabled: false,
          can_move_next: false 
        }
      };

      if (isDeathFlow) {
        resp.data.gender_list = [{id: "Male", title: "Male"}, {id: "Female", title: "Female"}];
      }

      // 3. Fetch Data (Logic shared by both)
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
      
      if (data?.p_id) { resp.data.can_move_next = true; }

      return res.status(200).send(encryptResponse(resp, aesKey, requestIv));
    }

    if (action === "complete") {
      return res.status(200).send(encryptResponse({ version: "7.1", data: { acknowledged: true } }, aesKey, requestIv));
    }
  } catch (err) {
    console.error("🔴 Server Error:", err.message);
    return res.status(200).json({ status: "error" });
  }
});

app.listen(3000, () => console.log("🚀 Multi-Flow Server Live"));
