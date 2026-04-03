const express = require("express");
const https = require("https");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/schedules", (req, res) => {
  const { fromPortId, toPortId } = req.query;

  if (!fromPortId || !toPortId) {
    return res.status(400).json({ IsSuccess: false, Data: "Missing fromPortId or toPortId" });
  }

  const url = `https://www.msc.com/api/feature/tools/SearchSchedule/SearchResults?fromPortId=${fromPortId}&toPortId=${toPortId}`;

  const options = {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://www.msc.com/en/search-a-schedule",
      "Origin": "https://www.msc.com",
    },
  };

  https
    .get(url, options, (apiRes) => {
      let data = "";
      apiRes.on("data", (chunk) => (data += chunk));
      apiRes.on("end", () => {
        try {
          res.setHeader("Content-Type", "application/json");
          res.send(data);
        } catch (e) {
          res.status(500).json({ IsSuccess: false, Data: "Failed to parse MSC response" });
        }
      });
    })
    .on("error", (err) => {
      res.status(500).json({ IsSuccess: false, Data: "Failed to reach MSC API: " + err.message });
    });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Next Sailings running on port ${PORT}`);
});
