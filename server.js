const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

/* TEST ROUTE */
app.get("/", (req, res) => {
  res.send("ABTYP WhatsApp Flow Server Running");
});

/* WHATSAPP FLOW ENDPOINT */
app.post("/", async (req, res) => {
  try {

    const screen = req.body.screen;
    const data = req.body.data || {};

    console.log("Incoming Flow Request:", req.body);

    /* COUNTRY SCREEN */
    if (screen === "COUNTRY_SCREEN") {

      const response = await axios.get(
        "https://api.abtyp.org/w0/get-country"
      );

      const countries = response.data.Data.map(c => ({
        id: String(c.Id),
        title: c.Name
      }));

      return res.json({
        screen: "COUNTRY_SCREEN",
        data: {
          country: countries
        }
      });
    }

    /* STATE SCREEN */
    if (screen === "STATE_SCREEN") {

      const countryId = data.country;

      const response = await axios.get(
        `https://api.abtyp.org/w0/get-state?CountryId=${countryId}`
      );

      const states = response.data.Data.map(s => ({
        id: String(s.Id),
        title: s.Name
      }));

      return res.json({
        screen: "STATE_SCREEN",
        data: {
          state: states
        }
      });
    }

    /* PARISHAD SCREEN */
    if (screen === "PARISHAD_SCREEN") {

      const stateId = data.state;

      const response = await axios.get(
        `https://api.abtyp.org/w0/get-parishad?StateId=${stateId}`
      );

      const parishads = response.data.Data.map(p => ({
        id: String(p.Id),
        title: p.Name
      }));

      return res.json({
        screen: "PARISHAD_SCREEN",
        data: {
          parishad: parishads
        }
      });
    }

    /* SUCCESS SCREEN */
    if (screen === "SUCCESS_SCREEN") {

      const parishadId = data.parishad;

      const response = await axios.get(
        `https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${parishadId}`
      );

      const link = response.data.Data.GroupLink;

      return res.json({
        screen: "SUCCESS_SCREEN",
        data: {
          link: link
        }
      });
    }

    return res.status(400).json({ error: "Unknown screen" });

  } catch (error) {

    console.error("Flow Error:", error.message);

    return res.status(500).json({
      error: "Server error"
    });
  }
});

/* SERVER START */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
