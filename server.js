const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

app.post("/", async (req, res) => {

  const screen = req.body.screen;

  if (screen === "COUNTRY_SCREEN") {

    const response = await axios.get(
      "https://api.abtyp.org/w0/get-country"
    );

    const countries = response.data.Data.map(c => ({
      id: c.Id,
      title: c.Name
    }));

    return res.json({
      screen: "COUNTRY_SCREEN",
      data: {
        country: countries
      }
    });

  }

  if (screen === "STATE_SCREEN") {

    const countryId = req.body.data.country;

    const response = await axios.get(
      `https://api.abtyp.org/w0/get-state?CountryId=${countryId}`
    );

    const states = response.data.Data.map(s => ({
      id: s.Id,
      title: s.Name
    }));

    return res.json({
      screen: "STATE_SCREEN",
      data: {
        state: states
      }
    });

  }

  if (screen === "PARISHAD_SCREEN") {

    const stateId = req.body.data.state;

    const response = await axios.get(
      `https://api.abtyp.org/w0/get-parishad?StateId=${stateId}`
    );

    const parishads = response.data.Data.map(p => ({
      id: p.Id,
      title: p.Name
    }));

    return res.json({
      screen: "PARISHAD_SCREEN",
      data: {
        parishad: parishads
      }
    });

  }

  if (screen === "SUCCESS_SCREEN") {

    const parishadId = req.body.data.parishad;

    const response = await axios.get(
      `https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${parishadId}`
    );

    return res.json({
      screen: "SUCCESS_SCREEN",
      data: {
        link: response.data.Data.GroupLink
      }
    });

  }

});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
