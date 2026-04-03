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

function doRequest(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: { ...headers },
    };
    if (payload) {
      opts.headers["Content-Type"] = "application/json";
      opts.headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        const cookies = (res.headers["set-cookie"] || []).map(c => c.split(";")[0]).join("; ");
        resolve({ status: res.statusCode, data, cookies });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function tryGetSession() {
  if (sessionCookies && Date.now() - sessionTime < 10 * 60 * 1000) return sessionCookies;
  try {
    console.log("[MSC] Getting session...");
    const r = await doRequest("GET", MSC_PAGE, {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,pt-BR;q=0.8",
      "Accept-Encoding": "identity",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    console.log(`[MSC] Session status: ${r.status}`);
    if (r.cookies) {
      sessionCookies = r.cookies;
      sessionTime = Date.now();
    }
    return sessionCookies;
  } catch (e) {
    console.log("[MSC] Session error:", e.message);
    return "";
  }
}

app.get("/api/schedules", async (req, res) => {
  const { fromPortId, toPortId } = req.query;
  if (!fromPortId || !toPortId) {
    return res.status(400).json({ IsSuccess: false, Data: "Missing fromPortId or toPortId" });
  }

  const tomorrow = new Date(Date.now() + 86400000);
  const fromDate = tomorrow.toISOString().split("T")[0];

  const payload = {
    FromDate: fromDate,
    fromPortId: parseInt(fromPortId),
    toPortId: parseInt(toPortId),
    language: "en",
    dataSourceId: DATA_SOURCE_ID,
  };

  const baseHeaders = {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,pt-BR;q=0.8",
    "Origin": "https://www.msc.com",
    "Referer": MSC_PAGE,
    "x-requested-with": "XMLHttpRequest",
    "Connection": "keep-alive",
  };

  // Attempt 1: POST directly without session
  console.log(`[MSC] POST ${fromPortId} -> ${toPortId}, date: ${fromDate}`);
  try {
    const r1 = await doRequest("POST", MSC_API, baseHeaders, payload);
    console.log(`[MSC] Direct POST status: ${r1.status}, len: ${r1.data.length}`);
    if (r1.status === 200) {
      try {
        const parsed = JSON.parse(r1.data);
        if (parsed.IsSuccess !== undefined) {
          res.setHeader("Content-Type", "application/json");
          return res.send(r1.data);
        }
      } catch (e) {}
    }

    // Attempt 2: With session cookies
    const cookies = await tryGetSession();
    if (cookies) {
      const r2 = await doRequest("POST", MSC_API, { ...baseHeaders, Cookie: cookies }, payload);
      console.log(`[MSC] Session POST status: ${r2.status}, len: ${r2.data.length}`);
      if (r2.status === 200) {
        res.setHeader("Content-Type", "application/json");
        return res.send(r2.data);
      }
    }

    // Attempt 3: Try alternative URL patterns
    const altUrls = [
      "https://www.msc.com/api/feature/tools/SearchSchedule/SearchResults",
      "https://www.msc.com/api/feature/tools/Schedule/Search",
    ];
    for (const alt of altUrls) {
      try {
        const r3 = await doRequest("POST", alt, baseHeaders, payload);
        console.log(`[MSC] Alt ${alt} status: ${r3.status}`);
        if (r3.status === 200) {
          try {
            const p = JSON.parse(r3.data);
            if (p.IsSuccess !== undefined) {
              res.setHeader("Content-Type", "application/json");
              return res.send(r3.data);
            }
          } catch (e) {}
        }
      } catch (e) { continue; }
    }

    // Also try GET with query params
    const getUrl = `https://www.msc.com/api/feature/tools/SearchSchedule/SearchResults?fromPortId=${fromPortId}&toPortId=${toPortId}`;
    try {
      const r4 = await doRequest("GET", getUrl, baseHeaders);
      console.log(`[MSC] GET fallback status: ${r4.status}`);
      if (r4.status === 200) {
        res.setHeader("Content-Type", "application/json");
        return res.send(r4.data);
      }
    } catch (e) {}

    // All failed - return error with debug info
    console.log(`[MSC] All attempts failed`);
    console.log(`[MSC] Last response preview: ${r1.data.substring(0, 200)}`);
    res.status(502).json({
      IsSuccess: false,
      Data: "MSC API blocked from this server (403). The MSC website blocks datacenter IPs.",
      debug: { directStatus: r1.status, sessionStatus: cookies ? "obtained" : "failed" },
    });
  } catch (err) {
    console.error("[MSC] Error:", err.message);
    sessionCookies = "";
    sessionTime = 0;
    res.status(502).json({ IsSuccess: false, Data: "Connection error: " + err.message });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", session: !!sessionCookies });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`Next Sailings running on port ${PORT}`));
