const express = require("express");
const axios = require("axios");
const app = express();

app.use(express.json());

/* COUNTRY API */
app.get("/countries", async (req, res) => {
  try {

    const response = await axios.get("https://api.abtyp.org/w0/get-country");

    const data = response.data.Data.map(c => ({
      id: c.Id,
      title: c.Name
    }));

    res.json(data);

  } catch (error) {
    res.status(500).send("Error fetching countries");
  }
});


/* STATE API */
app.get("/states", async (req, res) => {

  const countryId = req.query.country;

  try {

    const response = await axios.get(
      `https://api.abtyp.org/w0/get-state?CountryId=${countryId}`
    );

    const data = response.data.Data.map(s => ({
      id: s.Id,
      title: s.Name
    }));

    res.json(data);

  } catch (error) {
    res.status(500).send("Error fetching states");
  }

});


/* PARISHAD API */
app.get("/parishads", async (req, res) => {

  const stateId = req.query.state;

  try {

    const response = await axios.get(
      `https://api.abtyp.org/w0/get-parishad?StateId=${stateId}`
    );

    const data = response.data.Data.map(p => ({
      id: p.Id,
      title: p.Name
    }));

    res.json(data);

  } catch (error) {
    res.status(500).send("Error fetching parishads");
  }

});


/* FINAL GROUP LINK */
app.post("/get-group", async (req, res) => {

  const parishadId = req.body.parishad;

  try {

    const response = await axios.get(
      `https://api.abtyp.org/w0/get-whatsapp-group-link?ParishadId=${parishadId}`
    );

    res.json({
      link: response.data.Data.GroupLink
    });

  } catch (error) {
    res.status(500).send("Error fetching group link");
  }

});


const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
