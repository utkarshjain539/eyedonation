const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

/* Test Route */
app.get("/", (req, res) => {
  res.send("ABTYP WhatsApp Flow Server Running");
});

app.post("/", async (req, res) => {
  try {

    console.log("Incoming request:", req.body);

    const { action, screen, data } = req.body;

    /* INIT REQUEST (Flow opened) */
    if (action === "INIT") {

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

    return res.status(400).json({
      error: "Unhandled request",
      received: req.body
    });

  } catch (error) {

    console.error("Server error:", error.message);

    res.status(500).json({
      error: "Server error"
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
