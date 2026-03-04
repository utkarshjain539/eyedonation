const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

app.post("/flow", async (req, res) => {

  const screen = req.body.screen;

  if(screen === "COUNTRY_SCREEN"){

    const response = await axios.get("https://api.abtyp.org/w0/get-country");

    const countries = response.data.Data.map(c => ({
      id: c.Id,
      title: c.Name
    }));

    return res.json({
      data: {
        country: countries
      }
    });

  }

});
