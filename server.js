const express = require("express");
const https = require("https");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;
app.use(express.static(path.join(__dirname, "public")));

// =====================================================================
// === MSC (UNCHANGED — works via Cloudflare Worker; this is backup) ===
// =====================================================================
const MSC_API = "https://www.msc.com/api/feature/tools/SearchSailingRoutes";
const MSC_PAGE = "https://www.msc.com/en/search-a-schedule";
const DATA_SOURCE_ID = "{E9CCBD25-6FBA-4C5C-85F6-FC4F9E5A931F}";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let sessionCookies = "";
let sessionTime = 0;
const SESSION_TTL = 15 * 60 * 1000;

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, data, setCookies: res.headers["set-cookie"] || [] }));
    }).on("error", reject);
  });
}

function httpPostJson(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
    }, (res) => {
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
  if (sessionCookies && Date.now() - sessionTime < SESSION_TTL) return sessionCookies;
  console.log("[MSC] Getting new session...");
  const res = await httpGet(MSC_PAGE, { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" });
  sessionCookies = res.setCookies.map((c) => c.split(";")[0]).join("; ");
  sessionTime = Date.now();
  return sessionCookies;
}

app.get("/api/schedules", async (req, res) => {
  const { fromPortId, toPortId } = req.query;
  if (!fromPortId || !toPortId) return res.status(400).json({ IsSuccess: false, Data: "Missing fromPortId or toPortId" });
  try {
    const cookies = await getSession();
    const fromDate = new Date(Date.now() + 86400000).toISOString().split("T")[0];
    const result = await httpPostJson(MSC_API, {
      FromDate: fromDate, fromPortId: parseInt(fromPortId), toPortId: parseInt(toPortId),
      language: "en", dataSourceId: DATA_SOURCE_ID
    }, {
      "User-Agent": UA, "Accept": "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9",
      "Origin": "https://www.msc.com", "Referer": MSC_PAGE, "x-requested-with": "XMLHttpRequest", "Cookie": cookies,
    });
    res.setHeader("Content-Type", "application/json");
    res.send(result.data);
  } catch (err) {
    sessionCookies = ""; sessionTime = 0;
    res.status(502).json({ IsSuccess: false, Data: "MSC error: " + err.message });
  }
});

// =====================================================================
// === CMA CGM via Direct POST (cookie-based DataDome bypass) ===
// =====================================================================
// Discovery: instead of fighting DataDome at the export endpoint, we POST
// directly to the routing-finder page with a valid `datadome` cookie that
// was obtained ONCE from a real browser session. The HTML response embeds
// all the schedule data, which we extract via regex.
//
// Cost: $0/month forever. Latency: 1-3s.
// Trade-off: when the datadome cookie expires (typically every few days),
// someone needs to grab a fresh cookie from a real browser and update the
// CMA_COOKIES env var in Railway. ~30s of work per refresh.
//
// HOW TO REFRESH THE COOKIE:
// 1. In a normal browser, visit https://www.cma-cgm.com/ebusiness/schedules/routing-finder
// 2. Wait for the page to fully load (the DataDome JS challenge runs once on first visit)
// 3. Open DevTools (F12) → Application/Storage tab → Cookies → www.cma-cgm.com
// 4. Copy the values of these cookies (at minimum):
//    - datadome
//    - XSRF-TOKEN
//    - .AspNetCore.Session
//    - Human_Search
// 5. Or easier: in the Network tab, right-click any request to cma-cgm.com →
//    Copy → Copy as cURL → paste somewhere → grab the entire cookie header value
// 6. Paste the full "name1=value1; name2=value2; ..." string into the
//    CMA_COOKIES env var in Railway. Save. Done.
//
// Set this env var in Railway:
//   CMA_COOKIES = "datadome=xxx; XSRF-TOKEN=yyy; .AspNetCore.Session=zzz; Human_Search=1; ..."

// Sanitize: strip any \n, \r, \t and other control chars that often sneak in
// when copy-pasting from DevTools (which wraps the cookie value visually).
// Without this, Node throws "Invalid character in header content".
const CMA_COOKIES = (process.env.CMA_COOKIES || "")
  .replace(/[\r\n\t]+/g, "")
  .replace(/[\x00-\x1F\x7F]/g, "")
  .trim();
const CMA_ROUTING_URL = "https://www.cma-cgm.com/ebusiness/schedules/routing-finder";
const CMA_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

// POST to the CMA routing-finder page with form data + the saved datadome cookie.
// Returns { ok, status, body (string), contentType, elapsed }.
function cmaFetch(formData) {
  return new Promise((resolve, reject) => {
    if (!CMA_COOKIES) return reject(new Error("CMA_COOKIES env var not configured — see refresh instructions in server.js"));

    const body = Object.entries(formData)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    const startTime = Date.now();
    const u = new URL(CMA_ROUTING_URL);

    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname,
      method: "POST",
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "max-age=0",
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        "Origin": "https://www.cma-cgm.com",
        "Referer": CMA_ROUTING_URL,
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
        "User-Agent": CMA_UA,
        "Sec-Ch-Device-Memory": "8",
        "Sec-Ch-Ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Microsoft Edge";v="146"',
        "Sec-Ch-Ua-Arch": '"x86"',
        "Sec-Ch-Ua-Full-Version-List": '"Chromium";v="146.0.7680.179", "Not-A.Brand";v="24.0.0.0", "Microsoft Edge";v="146.0.3856.109"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Model": '""',
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Priority": "u=0, i",
        "Cookie": CMA_COOKIES,
      },
      timeout: 30000,
    }, (res) => {
      const status = res.statusCode;
      const contentType = res.headers["content-type"] || "";
      const encoding = res.headers["content-encoding"] || "";

      let stream = res;
      if (encoding === "gzip" || encoding === "x-gzip") {
        const zlib = require("zlib");
        stream = res.pipe(zlib.createGunzip());
      } else if (encoding === "br") {
        const zlib = require("zlib");
        stream = res.pipe(zlib.createBrotliDecompress());
      } else if (encoding === "deflate") {
        const zlib = require("zlib");
        stream = res.pipe(zlib.createInflate());
      }

      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => {
        resolve({
          ok: status === 200,
          status,
          body: Buffer.concat(chunks).toString("utf8"),
          contentType,
          elapsed: Date.now() - startTime,
        });
      });
      stream.on("error", reject);
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("CMA POST timeout (30s)")); });
    req.write(body);
    req.end();
  });
}

// === HTML → schedules parser ===
// Strips tags, normalizes whitespace, then runs a single regex over the text
// to pull each schedule card out of the routing-finder HTML.
function htmlToText(rawHtml) {
  let cleaned = rawHtml
    .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(div|p|li|tr|td|th|section|article|header|footer|h1|h2|h3|h4|h5|h6|br)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\u00a0/g, " ");

  return cleaned
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

const DAY_PATTERN = "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)";
const DATE_PATTERN = `${DAY_PATTERN},\\s+\\d{2}-[A-Z][a-z]{2}-\\d{4}`;

const SCHEDULE_REGEX = new RegExp(
  "(?<late_booking>Late booking\\s+)?" +
  `(?<departure>${DATE_PATTERN})\\s+` +
  "POL\\s+(?<pol>[^\\n]+)\\s+" +
  "(?<pol_terminal>[^\\n]+)\\s+" +
  "Port Cut-off\\s+" +
  "(?<port_cutoff>\\d{2}-[A-Z][a-z]{2}-\\d{4},\\s+\\d{2}:\\d{2}\\s+[AP]M)\\s+" +
  "Main vessel\\s+" +
  "(?<main_vessel>[^\\n]+)\\s+" +
  "Service\\s+" +
  "(?<service>[^\\n]+)\\s+" +
  "Voyage Ref\\.\\s+" +
  "(?<voyage_ref>[^\\n]+)\\s+" +
  `(?<arrival>${DATE_PATTERN})\\s+` +
  "POD\\s+(?<pod>[^\\n]+)\\s+" +
  "(?<pod_terminal>[^\\n]+)\\s+" +
  "(?<transit_time>\\d+\\s+Days)\\s+" +
  "(?<route_type>Direct|(?:\\d+\\s+Stop(?:s)?))\\s+" +
  "(?<co2>[\\d.]+\\s+CO2\\s+\\(t\\)/TEU)",
  "gi"
);

const MONTH_MAP = { JAN:"01", FEB:"02", MAR:"03", APR:"04", MAY:"05", JUN:"06", JUL:"07", AUG:"08", SEP:"09", OCT:"10", NOV:"11", DEC:"12" };
function parseCmaDate(str) {
  if (!str) return "";
  // CMA returns dates as "Tuesday, 14-APR-2026" (uppercase month)
  const m = str.match(/(\d{2})-([A-Z]{3})-(\d{4})/i);
  if (!m) return "";
  return `${m[3]}-${MONTH_MAP[m[2].toUpperCase()] || "01"}-${m[1]}`;
}

function parseCmaSchedules(rawHtml, polName, podName, polCode, podCode) {
  const text = htmlToText(rawHtml);
  const sailings = [];
  let match;
  SCHEDULE_REGEX.lastIndex = 0;
  while ((match = SCHEDULE_REGEX.exec(text)) !== null) {
    const groups = match.groups;
    const lateBooking = groups.late_booking;
    const departureRaw = groups.departure;
    const polRaw = groups.pol;
    const polTerminalRaw = groups.pol_terminal;
    const portCutoffRaw = groups.port_cutoff;
    const vesselRaw = groups.main_vessel;
    const serviceRaw = groups.service;
    const voyageRefRaw = groups.voyage_ref;
    const arrivalRaw = groups.arrival;
    const podRaw = groups.pod;
    const podTerminalRaw = groups.pod_terminal;
    const transitRaw = groups.transit_time;
    const routeTypeRaw = groups.route_type;
    const co2Raw = groups.co2;

    const vessel = (vesselRaw || "").trim();
    const service = (serviceRaw || "").trim();
    const svcCode = (service.match(/\(([^)]+)\)\s*$/) || [])[1] || service;
    const transitTime = parseInt(transitRaw, 10) || 0;
    const isDirect = /direct/i.test(routeTypeRaw || "");

    sailings.push({
      carrier: "CMA CGM",
      vessel: vessel || "TBN",
      service,
      serviceCode: svcCode,
      voyageRef: (voyageRefRaw || "").trim(),
      departureDate: parseCmaDate(departureRaw),
      arrivalDate: parseCmaDate(arrivalRaw),
      departureDateDisplay: (departureRaw || "").trim(),
      arrivalDateDisplay: (arrivalRaw || "").trim(),
      transitTime,
      co2: (co2Raw || "").trim(),
      isDirect,
      portCutoff: (portCutoffRaw || "").trim(),
      lateBooking: !!lateBooking,
      polTerminal: (polTerminalRaw || "").trim(),
      podTerminal: (podTerminalRaw || "").trim(),
      origin: polName.toUpperCase(),
      originCode: polCode,
      destination: podName.toUpperCase(),
      destinationCode: podCode,
    });
  }

  // Sort by departure date ascending
  sailings.sort((a, b) => (a.departureDate || "").localeCompare(b.departureDate || ""));
  return sailings;
}

// Build the SearchDate string in the format CMA expects: "09-Apr-2026"
function formatCmaSearchDate(date) {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const dd = String(date.getDate()).padStart(2, "0");
  const mmm = months[date.getMonth()];
  const yyyy = date.getFullYear();
  return `${dd}-${mmm}-${yyyy}`;
}

// === Cache ===
const CMA_CACHE = new Map();
const CMA_CACHE_TTL = 30 * 60 * 1000; // 30 min
function getCacheKey(pol, pod, weeks) { return `${pol}-${pod}-${weeks}`; }
function getCached(key) {
  const e = CMA_CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.time > CMA_CACHE_TTL) { CMA_CACHE.delete(key); return null; }
  return e.data;
}
function setCached(key, data) {
  CMA_CACHE.set(key, { time: Date.now(), data });
  if (CMA_CACHE.size > 100) {
    const now = Date.now();
    for (const [k, v] of CMA_CACHE.entries()) {
      if (now - v.time > CMA_CACHE_TTL) CMA_CACHE.delete(k);
    }
  }
}


// === CMA ENDPOINT ===
app.get("/api/cma", async (req, res) => {
  const { pol, pod, polName, podName, weeks, debug, nocache } = req.query;
  if (!pol || !pod || !polName || !podName) return res.status(400).json({ error: "Missing params" });

  const w = weeks || "5";
  const polDesc = `${polName.toUpperCase()} ; ${pol.substring(0,2)} ; ${pol}`;
  const podDesc = `${podName.toUpperCase()} ; ${pod.substring(0,2)} ; ${pod}`;

  // Cache check (still useful — sub-100ms vs ~1-3s for fresh fetch)
  const cacheKey = getCacheKey(pol, pod, w);
  if (!debug && !nocache) {
    const cached = getCached(cacheKey);
    if (cached) {
      console.log("[CMA] Cache HIT:", cacheKey);
      return res.json({ ...cached, cached: true });
    }
  }

  if (!CMA_COOKIES) {
    return res.status(500).json({
      error: "CMA_COOKIES env var not configured. Grab cookies from a real browser session at cma-cgm.com and paste the full cookie string into the CMA_COOKIES env var in Railway. See server.js comments for instructions.",
    });
  }

  // searchRange seems to be a numeric value: 100=1wk, 200=2wk, ..., 500=5wk.
  // The discovered Python script used 500. We mirror that pattern; if wrong
  // for some weeks values, the worst case is we get more or fewer schedules.
  const searchRange = String((parseInt(w, 10) || 5) * 100);
  const searchDate = formatCmaSearchDate(new Date());

  const formData = {
    ActualPOLDescription: polDesc,
    ActualPODDescription: podDesc,
    ActualPOLType: "Port",
    ActualPODType: "Port",
    polDescription: polDesc,
    podDescription: podDesc,
    IsDeparture: "True",
    SearchDate: searchDate,
    searchRange,
  };

  try {
    console.log("[CMA] POST routing-finder:", pol, "->", pod, "weeks:", w, "searchRange:", searchRange);
    const startTotal = Date.now();

    const result = await cmaFetch(formData);
    const totalElapsed = Date.now() - startTotal;
    console.log("[CMA] Response:", result.status, "size:", result.body.length, "elapsed:", totalElapsed + "ms");

    // Detect DataDome rejection (cookie expired or invalid)
    const isDataDomeBlock = result.status === 403
      || (result.body.length < 2000 && /captcha-delivery|Please enable JS|datadome/i.test(result.body));

    if (!result.ok || isDataDomeBlock) {
      return res.status(502).json({
        error: isDataDomeBlock
          ? "DataDome blocked the request — your CMA_COOKIES env var has likely expired. Grab fresh cookies from a browser session and update Railway."
          : "CMA POST failed",
        status: result.status,
        cookieExpired: isDataDomeBlock,
        elapsed: totalElapsed,
        preview: result.body.substring(0, 500),
      });
    }

    const sailings = parseCmaSchedules(result.body, polName, podName, pol, pod);

    if (debug) {
      return res.json({
        status: result.status,
        bodySize: result.body.length,
        elapsed: totalElapsed + "ms",
        sailingCount: sailings.length,
        cookieConfigured: !!CMA_COOKIES,
        firstSailing: sailings[0] || null,
        bodyPreview: result.body.substring(0, 500),
      });
    }

    if (sailings.length === 0) {
      return res.status(502).json({
        error: "No schedules found in HTML response. Either the route has no sailings, or the regex needs updating to match a new HTML format.",
        status: result.status,
        bodySize: result.body.length,
        elapsed: totalElapsed,
        bodyPreview: result.body.substring(0, 800),
      });
    }

    console.log("[CMA] Parsed", sailings.length, "sailings in", totalElapsed + "ms");
    const responseData = {
      success: true, sailings, count: sailings.length,
      origin: polDesc, destination: podDesc,
      method: "direct-post-cookie", elapsed: totalElapsed,
    };
    setCached(cacheKey, responseData);
    res.json(responseData);

  } catch (err) {
    console.error("[CMA] Error:", err.message);
    res.status(502).json({ error: "CMA failed: " + err.message });
  }
});

// === HEALTH ===
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    mscSession: !!sessionCookies,
    cmaCookieConfigured: !!CMA_COOKIES,
    cmaCookieLength: CMA_COOKIES ? CMA_COOKIES.length : 0,
    cmaHasDatadome: /datadome=/i.test(CMA_COOKIES),
    cmaHasXsrf: /XSRF-TOKEN=/i.test(CMA_COOKIES),
    cmaHasSession: /\.AspNetCore\.Session=/i.test(CMA_COOKIES),
    cmaCacheSize: CMA_CACHE.size,
    cmaCacheTTL: "30min",
    cmaMethod: "direct-post-cookie",
  });
});

// Diagnostic: do a real CMA search (Shanghai → Santos) and report status.
// Use this to quickly check if the cookies are still valid without going
// through the frontend. Returns sailing count + first sailing as proof.
app.get("/api/cma-test", async (req, res) => {
  if (!CMA_COOKIES) {
    return res.status(500).json({ error: "CMA_COOKIES not configured", cookieValid: false });
  }
  const pol = "CNSHA";
  const pod = "BRSSZ";
  const polName = "SHANGHAI";
  const podName = "SANTOS";
  const polDesc = `${polName.toUpperCase()} ; ${pol.substring(0,2)} ; ${pol}`;
  const podDesc = `${podName.toUpperCase()} ; ${pod.substring(0,2)} ; ${pod}`;
  const searchDate = formatCmaSearchDate(new Date());
  try {
    const formData = {
      ActualPOLDescription: polDesc,
      ActualPODDescription: podDesc,
      ActualPOLType: "Port",
      ActualPODType: "Port",
      polDescription: polDesc,
      podDescription: podDesc,
      IsDeparture: "True",
      SearchDate: searchDate,
      searchRange: "500",
    };
    
    const result = await cmaFetch(formData);
    const isDataDomeBlock = result.status === 403
      || (result.body.length < 2000 && /captcha-delivery|Please enable JS|datadome/i.test(result.body));
    const sailings = parseCmaSchedules(result.body, polName, podName, pol, pod);
    res.json({
      ok: result.ok && !isDataDomeBlock && sailings.length > 0,
      cookieValid: !isDataDomeBlock,
      status: result.status,
      bodySize: result.body.length,
      sailingCount: sailings.length,
      elapsed: result.elapsed + "ms",
      firstSailing: sailings[0] || null,
      note: isDataDomeBlock
        ? "❌ Cookies expired — refresh CMA_COOKIES env var in Railway"
        : sailings.length > 0
          ? `✅ CMA cookies working — found ${sailings.length} sailings Shanghai→Santos`
          : "⚠️ Got HTML but parser found no schedules — regex may need updating",
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log("Next Sailings running on port " + PORT);
  console.log("CMA cookies:", CMA_COOKIES ? `CONFIGURED (${CMA_COOKIES.length} chars)` : "NOT CONFIGURED");
});
