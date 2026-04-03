const express = require("express");
const https = require("https");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

const MSC_API = "https://www.msc.com/api/feature/tools/SearchSailingRoutes";
const MSC_PAGE = "https://www.msc.com/en/search-a-schedule";
const DATA_SOURCE_ID = "{E9CCBD25-6FBA-4C5C-85F6-FC4F9E5A931F}";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

let sessionCookies = "";
let sessionTime = 0;
const SESSION_TTL = 15 * 60 * 1000;

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, data, setCookies: res.headers["set-cookie"] || [] }));
    }).on("error", reject);
  });
}

function httpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const opts = {
      hostname: u.hostname,
      path: u.pathname,
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function getSession() {
  if (sessionCookies && Date.now() - sessionTime < SESSION_TTL) {
    return sessionCookies;
  }
  console.log("[MSC] Getting new session...");
  const res = await httpGet(MSC_PAGE, { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" });
  console.log("[MSC] Page status:", res.status, "cookies:", res.setCookies.length);
  sessionCookies = res.setCookies.map((c) => c.split(";")[0]).join("; ");
  sessionTime = Date.now();
  return sessionCookies;
}

app.get("/api/schedules", async (req, res) => {
  const { fromPortId, toPortId } = req.query;
  if (!fromPortId || !toPortId) {
    return res.status(400).json({ IsSuccess: false, Data: "Missing fromPortId or toPortId" });
  }

  try {
    const cookies = await getSession();

    const tomorrow = new Date(Date.now() + 86400000);
    const fromDate = tomorrow.toISOString().split("T")[0];

    const payload = {
      FromDate: fromDate,
      fromPortId: parseInt(fromPortId),
      toPortId: parseInt(toPortId),
      language: "en",
      dataSourceId: DATA_SOURCE_ID,
    };

    console.log("[MSC] POST", fromPortId, "->", toPortId, "date:", fromDate);

    const result = await httpPost(MSC_API, payload, {
      "User-Agent": UA,
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Origin": "https://www.msc.com",
      "Referer": MSC_PAGE,
      "x-requested-with": "XMLHttpRequest",
      "Cookie": cookies,
    });

    console.log("[MSC] Response status:", result.status, "length:", result.data.length);

    res.setHeader("Content-Type", "application/json");
    res.send(result.data);
  } catch (err) {
    console.error("[MSC] Error:", err.message);
    sessionCookies = "";
    sessionTime = 0;
    res.status(502).json({ IsSuccess: false, Data: "Failed to reach MSC API: " + err.message });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", hasSession: !!sessionCookies });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log("Next Sailings running on port " + PORT);
});
