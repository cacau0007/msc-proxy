const express = require("express");
const https = require("https");
const http = require("http");
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

// === Flexible HTTP request with redirect following & cookie collection ===
function httpReq(url, options = {}, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const lib = isHttps ? https : http;
    const method = options.method || "GET";
    const body = options.body || null;

    const reqHeaders = {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,pt-BR;q=0.8",
      ...(options.headers || {}),
    };

    const reqOpts = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: reqHeaders,
    };

    const req = lib.request(reqOpts, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        const newUrl = new URL(res.headers.location, url).toString();
        // Collect cookies from redirect
        const newCookies = (res.headers["set-cookie"] || []).map(c => c.split(";")[0]);
        const existingCookies = reqHeaders["Cookie"] || "";
        const mergedCookies = [existingCookies, ...newCookies].filter(Boolean).join("; ");
        return resolve(httpReq(newUrl, { ...options, headers: { ...reqHeaders, Cookie: mergedCookies }, method: res.statusCode === 303 ? "GET" : method, body: res.statusCode === 303 ? null : body }, maxRedirects - 1));
      }

      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        data,
        setCookies: res.headers["set-cookie"] || [],
      }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// === MSC SESSION ===
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

// === MSC SCHEDULES ===
app.get("/api/schedules", async (req, res) => {
  const { fromPortId, toPortId } = req.query;
  if (!fromPortId || !toPortId) {
    return res.status(400).json({ IsSuccess: false, Data: "Missing fromPortId or toPortId" });
  }
  try {
    const cookies = await getSession();
    const tomorrow = new Date(Date.now() + 86400000);
    const fromDate = tomorrow.toISOString().split("T")[0];
    const payload = { FromDate: fromDate, fromPortId: parseInt(fromPortId), toPortId: parseInt(toPortId), language: "en", dataSourceId: DATA_SOURCE_ID };
    console.log("[MSC] POST", fromPortId, "->", toPortId, "date:", fromDate);
    const result = await httpPost(MSC_API, payload, {
      "User-Agent": UA, "Accept": "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9",
      "Origin": "https://www.msc.com", "Referer": MSC_PAGE, "x-requested-with": "XMLHttpRequest", "Cookie": cookies,
    });
    console.log("[MSC] Response status:", result.status, "length:", result.data.length);
    res.setHeader("Content-Type", "application/json");
    res.send(result.data);
  } catch (err) {
    console.error("[MSC] Error:", err.message);
    sessionCookies = ""; sessionTime = 0;
    res.status(502).json({ IsSuccess: false, Data: "Failed to reach MSC API: " + err.message });
  }
});

// === CMA CGM HTML PARSER ===
function parseCmaHtml(html, polName, podName, polCode, podCode) {
  const sailings = [];
  if (!html || !html.includes("cardelem")) return sailings;

  const cards = html.split('<li class="cardelem ');
  for (let i = 1; i < cards.length; i++) {
    const card = cards[i];
    try {
      const solMatch = card.match(/^(solution_\d+)/);
      const solution = solMatch ? solMatch[1] : "";

      const depMatch = card.match(/DepartureDatesCls" data-event-date="([^"]+)"/);
      if (!depMatch) continue;
      const depDate = depMatch[1];

      const arrMatch = card.match(/ArrivalDatesCls" data-event-date="([^"]+)"/);
      const arrDate = arrMatch ? arrMatch[1] : "";

      const dateMatches = [...card.matchAll(/<span class="date">([^<]+)<\/span>/g)];
      const depDisplay = dateMatches[0] ? dateMatches[0][1].trim() : "";
      const arrDisplay = dateMatches[1] ? dateMatches[1][1].trim() : "";

      const vesselMatch = card.match(/<dt>Main vessel<\/dt>\s*<dd>([^<]+)<\/dd>/);
      const vessel = vesselMatch ? vesselMatch[1].trim() : "TBN";

      const serviceMatch = card.match(/alt='name of the line'>([^<]+)<\/a>/);
      const service = serviceMatch ? serviceMatch[1].trim() : "";
      const svcCodeMatch = service.match(/\(([^)]+)\)\s*$/);
      const serviceCode = svcCodeMatch ? svcCodeMatch[1] : service;

      const voyageMatch = card.match(/voyageReference=([^"&]+)/);
      const voyageRef = voyageMatch ? voyageMatch[1] : "";

      const ttMatch = card.match(/Transitcls" data-value="(\d+)"/);
      const transitTime = ttMatch ? parseInt(ttMatch[1]) : 0;

      const co2Match = card.match(/TotalCo2Cls" data-value="([^"]+)"/);
      const co2 = co2Match ? co2Match[1] : "";

      const isDirect = card.includes('"transit direct"');

      const cutoffMatch = card.match(/<dt>Port Cut-off<\/dt>\s*<dd>([^<]+)<\/dd>/);
      const portCutoff = cutoffMatch ? cutoffMatch[1].trim() : "";

      let depISO = "", arrISO = "";
      if (depDate) { const [m, d, y] = depDate.split("/"); depISO = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`; }
      if (arrDate) { const [m, d, y] = arrDate.split("/"); arrISO = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`; }

      sailings.push({
        carrier: "CMA CGM", vessel, service, serviceCode, voyageRef,
        departureDate: depISO, arrivalDate: arrISO,
        departureDateDisplay: depDisplay, arrivalDateDisplay: arrDisplay,
        transitTime, co2, isDirect, portCutoff,
        origin: polName.toUpperCase(), originCode: polCode,
        destination: podName.toUpperCase(), destinationCode: podCode, solution,
      });
    } catch (e) { continue; }
  }
  return sailings;
}

// === CMA CGM SCHEDULES (Railway proxy) ===
let cmaCookies = "";
let cmaCookieTime = 0;
const CMA_SESSION_TTL = 10 * 60 * 1000;

app.get("/api/cma", async (req, res) => {
  const { pol, pod, polName, podName, weeks, debug } = req.query;
  if (!pol || !pod || !polName || !podName) {
    return res.status(400).json({ error: "Missing pol, pod, polName, podName" });
  }

  const w = weeks || "5";
  const polCC = pol.substring(0, 2);
  const podCC = pod.substring(0, 2);
  const polDesc = `${polName.toUpperCase()} ; ${polCC} ; ${pol}`;
  const podDesc = `${podName.toUpperCase()} ; ${podCC} ; ${pod}`;

  try {
    // Step 1: Get session cookies from CMA
    if (!cmaCookies || Date.now() - cmaCookieTime > CMA_SESSION_TTL) {
      console.log("[CMA] Getting session cookies...");
      const pageRes = await httpReq("https://www.cma-cgm.com/ebusiness/schedules", {
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
          "Cache-Control": "no-cache",
          "Sec-Ch-Ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Brave";v="146"',
          "Sec-Ch-Ua-Mobile": "?0",
          "Sec-Ch-Ua-Platform": '"Windows"',
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Upgrade-Insecure-Requests": "1",
        },
      });
      console.log("[CMA] Page status:", pageRes.status, "cookies:", pageRes.setCookies.length);
      cmaCookies = pageRes.setCookies.map(c => c.split(";")[0]).join("; ");
      cmaCookieTime = Date.now();
    }

    // Step 2: Build form data
    const tomorrow = new Date(Date.now() + 86400000);
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const searchDate = `${String(tomorrow.getDate()).padStart(2, "0")}-${months[tomorrow.getMonth()]}-${tomorrow.getFullYear()}`;

    const formData = [
      `ActualPOLDescription=${encodeURIComponent(polDesc)}`,
      `ActualPODDescription=${encodeURIComponent(podDesc)}`,
      `ActualPOLType=Port`,
      `ActualPODType=Port`,
      `polDescription=${encodeURIComponent(polDesc)}`,
      `podDescription=${encodeURIComponent(podDesc)}`,
      `IsDeparture=True`,
      `SearchDate=${encodeURIComponent(searchDate)}`,
      `searchRange=${w}`,
    ].join("&");

    console.log("[CMA] POST", pol, "->", pod, "date:", searchDate, "weeks:", w);

    // Step 3: POST the form
    const result = await httpReq("https://www.cma-cgm.com/ebusiness/schedules/routing-finder", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(formData).toString(),
        "Origin": "https://www.cma-cgm.com",
        "Referer": "https://www.cma-cgm.com/ebusiness/schedules/routing-finder",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cookie": cmaCookies,
        "Sec-Ch-Ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Brave";v="146"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Upgrade-Insecure-Requests": "1",
      },
      body: formData,
    });

    console.log("[CMA] Response status:", result.status, "length:", result.data.length);

    // Collect new cookies
    if (result.setCookies.length > 0) {
      const newC = result.setCookies.map(c => c.split(";")[0]).join("; ");
      cmaCookies = cmaCookies + "; " + newC;
    }

    // Debug mode
    if (debug) {
      return res.json({
        status: result.status,
        htmlLength: result.data.length,
        hasCardelem: result.data.includes("cardelem"),
        hasScheduleResults: result.data.includes("Schedule results"),
        hasCaptcha: result.data.includes("captcha") || result.data.includes("challenge"),
        hasDatadome: result.data.includes("datadome"),
        cookiesCount: cmaCookies.split(";").length,
        first2000: result.data.substring(0, 2000),
      });
    }

    // Step 4: Parse HTML
    const sailings = parseCmaHtml(result.data, polName, podName, pol, pod);

    if (sailings.length === 0 && result.status === 403) {
      // Reset cookies and report error
      cmaCookies = ""; cmaCookieTime = 0;
      return res.status(502).json({ error: "CMA blocked request (DataDome). Try again." });
    }

    res.json({ success: true, sailings, count: sailings.length,
      origin: polDesc, destination: podDesc });

  } catch (err) {
    console.error("[CMA] Error:", err.message);
    cmaCookies = ""; cmaCookieTime = 0;
    res.status(502).json({ error: "CMA request failed: " + err.message });
  }
});

// === HEALTH ===
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", hasSession: !!sessionCookies, hasCmaCookies: !!cmaCookies });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log("Next Sailings running on port " + PORT);
});
