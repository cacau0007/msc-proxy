const express = require("express");
const https = require("https");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 8080;
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "1mb" }));

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
// NOTE: `let` (not const) so the /api/cookies endpoint can hot-swap at runtime.
let CMA_COOKIES = (process.env.CMA_COOKIES || "")
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

    // --- Block detection: three tiers ---
    //
    // TIER 1 (classic bot-block): status 403 OR tiny body with explicit block markers.
    //   Clear-cut hard rejection by DataDome.
    //
    // TIER 2 (scheduled maintenance): CMA periodically takes their eBusiness site
    //   down for maintenance (usually weekend night UTC). The response is a
    //   regular-looking HTML page (~220-230KB) with marketing chrome but an
    //   explicit maintenance message. Detectable by string presence.
    //
    // TIER 3 (stealth bot-block): status 200 + body in the 200-240KB band,
    //   WITHOUT the schedule markers ("Main vessel" and "Port Cut-off") AND
    //   WITHOUT maintenance markers. This is the DataDome templated shell.
    //   If maintenance markers are present → it's Tier 2, not Tier 3.
    const hasScheduleMarkers = /Main vessel/i.test(result.body)
                            && /Port Cut-off/i.test(result.body);
    const isMaintenance = /scheduled maintenance|improving the eBusiness|eBusiness website will be unavailable/i.test(result.body);
    const isClassicBlock = result.status === 403
      || (result.body.length < 2000 && /captcha-delivery|Please enable JS|datadome/i.test(result.body));
    const isStealthBlock = result.status === 200
      && result.body.length > 0
      && result.body.length < 250000
      && !hasScheduleMarkers
      && !isMaintenance;  // don't confuse maintenance with bot-block
    const isDataDomeBlock = isClassicBlock || isStealthBlock;

    if (!result.ok || isDataDomeBlock || isMaintenance) {
      // Always log the preview when we think we've been blocked — this makes
      // it easy to tune the heuristic if CMA changes their response shape.
      console.log("[CMA] BLOCK DETECTED:",
        "maintenance=" + isMaintenance,
        "classicBlock=" + isClassicBlock,
        "stealthBlock=" + isStealthBlock,
        "hasMarkers=" + hasScheduleMarkers,
        "bodyStart:", result.body.substring(0, 300).replace(/\s+/g, " "));

      // Maintenance is an upstream outage, not a cookie issue — surface it
      // differently so the user doesn't waste time refreshing cookies.
      if (isMaintenance) {
        // Try to extract the specific maintenance window text if CMA provides it
        const windowMatch = result.body.match(/will be unavailable on[^<.]+(?:CEST|UTC|GMT)[^<.]*/i);
        const maintenanceWindow = windowMatch ? windowMatch[0].trim() : null;
        return res.status(503).json({
          error: "CMA eBusiness site is under scheduled maintenance — not a cookie problem. "
               + "Cookies are fine, the upstream service is intentionally offline. "
               + (maintenanceWindow ? `Window: ${maintenanceWindow}. ` : "")
               + "Try again after the maintenance window ends.",
          status: result.status,
          maintenance: true,
          maintenanceWindow,
          elapsed: totalElapsed,
          bodySize: result.body.length,
        });
      }

      // Build cookie diagnostics so we can see exactly what was sent
      const cookieParts = CMA_COOKIES.split(";").map(c => c.trim().split("=")[0]);
      return res.status(502).json({
        error: isDataDomeBlock
          ? (isStealthBlock
              ? `DataDome appears to have silently blocked the request (HTTP 200 but body is ${result.body.length} bytes and lacks schedule markers). Refresh CMA_COOKIES env var in Railway — your DataDome cookie has likely expired or been tainted.`
              : "DataDome blocked the request — your CMA_COOKIES env var has likely expired. Grab fresh cookies from a browser session and update Railway.")
          : "CMA POST failed",
        status: result.status,
        cookieExpired: isDataDomeBlock,
        blockType: isStealthBlock ? "stealth-200" : (isClassicBlock ? "classic" : "none"),
        elapsed: totalElapsed,
        diagnostics: {
          cookieLength: CMA_COOKIES.length,
          cookieCount: cookieParts.length,
          cookieNames: cookieParts,
          hasDatadome: /(?:^|;\s*)datadome=/i.test(CMA_COOKIES),
          hasXsrf: /(?:^|;\s*)XSRF-TOKEN=/i.test(CMA_COOKIES),
          hasSession: /(?:^|;\s*)\.AspNetCore\.Session=/i.test(CMA_COOKIES),
          hasHumanSearch: /(?:^|;\s*)Human_Search=/i.test(CMA_COOKIES),
          datadomeFirst20: (CMA_COOKIES.match(/datadome=([^;]+)/i) || [])[1]?.substring(0, 20) || "(missing)",
          responseBytes: result.body.length,
          responseStart: result.body.substring(0, 200),
          hasScheduleMarkers,
        },
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
        hasScheduleMarkers,
        firstSailing: sailings[0] || null,
        bodyPreview: result.body.substring(0, 500),
      });
    }

    if (sailings.length === 0) {
      // This path means: got past the block detector (response looks real),
      // but regex found zero schedules. Log the preview for easier debugging.
      console.log("[CMA] ZERO SAILINGS (passed block check) — bodyStart:",
        result.body.substring(0, 300).replace(/\s+/g, " "));
      return res.status(502).json({
        error: "No schedules found in HTML response. Either the route has no sailings, or the regex needs updating to match a new HTML format.",
        status: result.status,
        bodySize: result.body.length,
        elapsed: totalElapsed,
        hasScheduleMarkers,
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

// =====================================================================
// === MAERSK via public JSON API (no DataDome, no cookies, no scrape) ==
// =====================================================================
// Discovery: the public maersk.com schedule page consumes a clean JSON API
// authenticated only by a public `consumer-key` header. No cookies, no
// challenge, no HTML parsing. Two endpoints involved:
//
//   1) GET  /synergy/reference-data/geography/locations?cityName=...&type=city
//      → returns list of cities with maerskGeoLocationId + unLocCode. We use
//        this to translate UN/LOCODE (e.g. BRSSZ) to Maersk's proprietary
//        GEO_ID (e.g. 1BX66GARX9UAH) which the schedule endpoint requires.
//
//   2) POST /routing-unified/routing/routings-queries
//      → the actual schedule search. Takes startLocation/endLocation as
//        GEO_IDs (not UN/LOCODEs). Returns routings[] with vessel, service,
//        ETD/ETA, voyage number.
//
// The `consumer-key` is a PUBLIC app key (visible in any browser devtools on
// maersk.com). No login required, no rate-limit encountered in testing.
//
// Cost: $0/month. Latency: ~1-2s for the routing query + one-time ~300ms
// for the geo-id lookup (cached in-memory so subsequent requests skip it).

const MAERSK_CONSUMER_KEY = "uXe7bxTHLY0yY0e8jnS6kotShkLuAAqG";
const MAERSK_LOCATIONS_URL = "https://api.maersk.com/synergy/reference-data/geography/locations";
const MAERSK_ROUTINGS_URL = "https://api.maersk.com/routing-unified/routing/routings-queries";
const MAERSK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

// Akamai Bot Manager anti-bot token. The Maersk routings endpoint is protected
// by Akamai BM, which validates this header (a JS-generated fingerprint blob).
// The /locations endpoint does NOT require it — only POST /routings-queries.
//
// HOW TO REFRESH:
//  1. In a real browser, open https://www.maersk.com/schedules/point-to-point
//  2. Do a real search so the POST routings-queries fires
//  3. DevTools → Network → find routings-queries → right-click → Copy as cURL
//  4. From the cURL, extract the value of the `akamai-bm-telemetry` header
//     (it's huge — thousands of chars — starts with "a=F124...")
//  5. Paste into Railway env var MAERSK_BM_TELEMETRY
//
// TTL: unclear — the token includes timestamps, so it may have an effective
// lifetime of minutes to hours. If Maersk searches start 403'ing, refresh.
// Same sanitization as CMA_COOKIES: strip control chars that DevTools injects.
// `let` (not const) so /api/cookies can hot-swap it at runtime.
let MAERSK_BM_TELEMETRY = (process.env.MAERSK_BM_TELEMETRY || "")
  .replace(/[\r\n\t]+/g, "")
  .replace(/[\x00-\x1F\x7F]/g, "")
  .trim();

// Cache UN/LOCODE → GEO_ID lookups indefinitely (they never change)
const MAERSK_GEO_CACHE = new Map();

// Cache schedule responses for 30 min (same TTL as CMA)
const MAERSK_CACHE = new Map();
const MAERSK_CACHE_TTL = 30 * 60 * 1000;

function httpsGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search, method: "GET",
      headers, timeout: 20000,
    }, (res) => {
      const encoding = res.headers["content-encoding"] || "";
      let stream = res;
      if (encoding === "gzip" || encoding === "x-gzip") {
        stream = res.pipe(require("zlib").createGunzip());
      } else if (encoding === "br") {
        stream = res.pipe(require("zlib").createBrotliDecompress());
      } else if (encoding === "deflate") {
        stream = res.pipe(require("zlib").createInflate());
      }
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      stream.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Maersk GET timeout (20s)")); });
    req.end();
  });
}

function httpsPostJsonMaersk(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search, method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(payload) },
      timeout: 30000,
    }, (res) => {
      const encoding = res.headers["content-encoding"] || "";
      let stream = res;
      if (encoding === "gzip" || encoding === "x-gzip") {
        stream = res.pipe(require("zlib").createGunzip());
      } else if (encoding === "br") {
        stream = res.pipe(require("zlib").createBrotliDecompress());
      } else if (encoding === "deflate") {
        stream = res.pipe(require("zlib").createInflate());
      }
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      stream.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Maersk POST timeout (30s)")); });
    req.write(payload);
    req.end();
  });
}

// Look up a Maersk GEO_ID from UN/LOCODE. Uses cityName as a search seed
// Strip diacritics: "Itapoá" → "Itapoa", "Santarém" → "Santarem".
// The Maersk API stores city names without accents and does literal matching,
// so passing "Itapoá" returns 404 while "Itapoa" returns the match.
function stripDiacritics(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// (API doesn't accept unLocCode directly, but returns unLocCode in results
// so we filter by that after the call). Caches by UN/LOCODE forever.
async function maerskLookupGeoId(unLocCode, cityName) {
  if (!unLocCode) throw new Error("UN/LOCODE required for Maersk lookup");
  const cacheKey = unLocCode.toUpperCase();
  if (MAERSK_GEO_CACHE.has(cacheKey)) return MAERSK_GEO_CACHE.get(cacheKey);

  // Build a ranked list of search terms to try. Each try is cheap (one GET)
  // and the Maersk endpoint is picky: must be accent-free and match a city
  // prefix. We start with the full normalized name, then degrade to a 4-char
  // prefix (handles "Itapoa" → "Itap" which also matches "Itapoã" variants),
  // then finally just the city part of the UN/LOCODE as last resort.
  const normalized = stripDiacritics(cityName || "").trim();
  const candidates = [];
  if (normalized) candidates.push(normalized);
  if (normalized.length > 4) candidates.push(normalized.substring(0, 4));
  // UN/LOCODE suffix as last resort (e.g. "BRIOA" → "IOA" — API sometimes
  // matches Maersk's internal Rkst code fields against this)
  if (cacheKey.length >= 5) candidates.push(cacheKey.substring(2));

  let lastError = null;
  let combinedList = [];

  for (const term of candidates) {
    const qs = new URLSearchParams({
      cityName: term,
      pageSize: "25",
      sort: "cityName",
      type: "city",
    }).toString();

    const url = `${MAERSK_LOCATIONS_URL}?${qs}`;
    console.log("[MAERSK] Lookup:", cityName, "→ try term:", term, "filter by", cacheKey);

    let result;
    try {
      result = await httpsGetJson(url, {
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate, br",
        "Consumer-Key": MAERSK_CONSUMER_KEY,
        "Origin": "https://www.maersk.com",
        "Referer": "https://www.maersk.com/",
        "User-Agent": MAERSK_UA,
      });
    } catch (e) {
      lastError = e;
      continue;
    }

    // 404 on this endpoint means "no matches" — try next candidate
    if (result.status === 404) { lastError = new Error(`HTTP 404 for term "${term}"`); continue; }
    if (result.status !== 200) { lastError = new Error(`Maersk locations lookup failed: HTTP ${result.status}`); continue; }

    let list;
    try { list = JSON.parse(result.body); }
    catch (e) { lastError = new Error("Maersk locations response not JSON"); continue; }
    if (!Array.isArray(list)) { lastError = new Error("Maersk locations response is not an array"); continue; }

    combinedList = combinedList.concat(list);

    // Exact match by UN/LOCODE (there may be homonym cities — e.g. "Santos"
    // matches both BRSSZ and HUHBG, so filtering by unLocCode is critical).
    const match = list.find(loc => (loc.unLocCode || "").toUpperCase() === cacheKey);
    if (match) {
      MAERSK_GEO_CACHE.set(cacheKey, match.maerskGeoLocationId);
      return match.maerskGeoLocationId;
    }
  }

  // Final fallback across all accumulated results: cityName + countryCode
  // (handles cases where unLocCode is missing in API response but city matches)
  const countryPrefix = cacheKey.substring(0, 2);
  const fallback = combinedList.find(loc =>
    (loc.countryCode || "").toUpperCase() === countryPrefix &&
    stripDiacritics((loc.cityName || "").toLowerCase()) === stripDiacritics((cityName || "").toLowerCase())
  );
  if (fallback) {
    MAERSK_GEO_CACHE.set(cacheKey, fallback.maerskGeoLocationId);
    return fallback.maerskGeoLocationId;
  }

  throw new Error(
    `Maersk GEO_ID not found for ${cacheKey} (${cityName}). ` +
    `Tried ${candidates.length} search terms, got ${combinedList.length} total results but none matched UN/LOCODE. ` +
    (lastError ? `Last error: ${lastError.message}` : "")
  );
}

// Parse ISO-8601 duration "P37DT12H" → 37 (days). Rounds up partial days.
function parseIsoDurationDays(iso) {
  if (!iso) return 0;
  const m = String(iso).match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/);
  if (!m) return 0;
  const d = parseInt(m[1] || "0", 10);
  const h = parseInt(m[2] || "0", 10);
  return h >= 12 ? d + 1 : d;
}

// Normalize a Maersk routing into the shape the frontend consumes
// (parallel to parseCmaSchedules output, but with Maersk-specific fields).
function normalizeMaerskRoutings(json, polName, podName, polCode, podCode) {
  const routings = (json && json.routings) || [];
  const sailings = [];

  for (const r of routings) {
    const legs = r.routingLegs || [];
    if (!legs.length) continue;

    const firstLeg = legs[0];
    const lastLeg = legs[legs.length - 1];
    const firstCarriage = firstLeg.carriage || {};
    const lastCarriage = lastLeg.carriage || {};
    const start = firstCarriage.vesselPortCallStart || {};
    const end = lastCarriage.vesselPortCallEnd || {};

    const vessel = (firstCarriage.vessel && firstCarriage.vessel.vesselName) || "TBN";
    const service = (start.departureService && start.departureService.serviceName)
                 || (start.arrivalService && start.arrivalService.serviceName) || "";
    const serviceCode = (start.departureService && start.departureService.serviceCode)
                     || (start.arrivalService && start.arrivalService.serviceCode) || "";
    const voyageRef = start.departureVoyageNumber || "";
    const etd = start.estimatedTimeOfDeparture || "";
    const eta = end.estimatedTimeOfArrival || "";

    const transitDays = parseIsoDurationDays(r.estimatedTransitTime);
    const isDirect = legs.length === 1;

    // Build per-leg breakdown (for transshipment cards)
    const legDetails = legs.map(l => {
      const c = l.carriage || {};
      const s = c.vesselPortCallStart || {};
      const e = c.vesselPortCallEnd || {};
      return {
        vessel: (c.vessel && c.vessel.vesselName) || "TBN",
        voyageRef: s.departureVoyageNumber || "",
        service: (s.departureService && s.departureService.serviceName) || "",
        serviceCode: (s.departureService && s.departureService.serviceCode) || "",
        etd: s.estimatedTimeOfDeparture || "",
        eta: e.estimatedTimeOfArrival || "",
        polFacility: (s.location && s.location.facility && s.location.facility.facilityCode) || "",
        podFacility: (e.location && e.location.facility && e.location.facility.facilityCode) || "",
      };
    });

    sailings.push({
      carrier: "MAERSK",
      vessel,
      service,
      serviceCode,
      voyageRef,
      // NOTE: return full datetime (not date-only) to avoid timezone shift
      // when the frontend does `new Date(s)` and renders via .getDate() —
      // a date-only string is interpreted as UTC midnight and shifts one day
      // back for users in negative TZs (e.g. BRT). Full datetime is parsed
      // as local time and renders correctly.
      departureDate: etd || "",
      arrivalDate: eta || "",
      departureDateTime: etd,
      arrivalDateTime: eta,
      transitTime: transitDays,
      isDirect,
      legCount: legs.length,
      legs: legDetails,
      routeCode: r.routeCode || "",
      origin: polName.toUpperCase(),
      originCode: polCode,
      destination: podName.toUpperCase(),
      destinationCode: podCode,
    });
  }

  sailings.sort((a, b) => (a.departureDate || "").localeCompare(b.departureDate || ""));
  return sailings;
}

function getMaerskCached(key) {
  const e = MAERSK_CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.time > MAERSK_CACHE_TTL) { MAERSK_CACHE.delete(key); return null; }
  return e.data;
}
function setMaerskCached(key, data) {
  MAERSK_CACHE.set(key, { time: Date.now(), data });
  if (MAERSK_CACHE.size > 100) {
    const now = Date.now();
    for (const [k, v] of MAERSK_CACHE.entries()) {
      if (now - v.time > MAERSK_CACHE_TTL) MAERSK_CACHE.delete(k);
    }
  }
}

// === MAERSK ENDPOINT ===
app.get("/api/maersk", async (req, res) => {
  const { pol, pod, polName, podName, weeks, debug, nocache } = req.query;
  if (!pol || !pod || !polName || !podName) return res.status(400).json({ error: "Missing params" });

  const w = parseInt(weeks || "5", 10);
  const cacheKey = `${pol}-${pod}-${w}`;

  if (!debug && !nocache) {
    const cached = getMaerskCached(cacheKey);
    if (cached) {
      console.log("[MAERSK] Cache HIT:", cacheKey);
      return res.json({ ...cached, cached: true });
    }
  }

  try {
    const startTotal = Date.now();

    // Step 1: resolve UN/LOCODEs to Maersk GEO_IDs (cached after first call)
    const [startGeoId, endGeoId] = await Promise.all([
      maerskLookupGeoId(pol, polName),
      maerskLookupGeoId(pod, podName),
    ]);

    // Step 2: build time range (earliestTime = tomorrow, latestTime = +weeks)
    const today = new Date();
    const earliest = new Date(today.getTime() + 86400000);
    const latest = new Date(today.getTime() + w * 7 * 86400000);
    const toIsoDate = (d) => d.toISOString().split("T")[0];

    const payload = {
      requestType: "DATED_SCHEDULES",
      includeFutureSchedules: true,
      routingCondition: "PREFERRED",
      IsUseOfInternetMarkedRoutesOnly: false,
      brandCode: "MSL",
      cargo: { cargoType: "DRY", isTemperatureControlRequired: false },
      carriage: { vessel: { flagCountryCode: "" } },
      startLocation: {
        dataObject: "CITY",
        cityCode: "",
        alternativeCodes: [{ alternativeCodeType: "GEO_ID", alternativeCode: startGeoId }],
      },
      endLocation: {
        dataObject: "CITY",
        cityCode: "",
        alternativeCodes: [{ alternativeCodeType: "GEO_ID", alternativeCode: endGeoId }],
      },
      equipment: {
        equipmentSizeCode: "40",
        equipmentTypeCode: "HDRY",
        constructionMaterial: "",
        isEmpty: false,
        isShipperOwned: false,
      },
      exportServiceType: "CY",
      importServiceType: "CY",
      timeRange: {
        routingsBasedOn: "DEPARTURE_DATE",
        earliestTime: toIsoDate(earliest),
        latestTime: toIsoDate(latest),
      },
    };

    console.log("[MAERSK] POST routings:", pol, "→", pod, `(${startGeoId} → ${endGeoId})`);

    // Replicate ALL headers that Brave/Chrome sends — the Akamai Bot Manager
    // fingerprints these and rejects requests missing sec-fetch-* or sec-ch-ua*.
    // The `akamai-bm-telemetry` is the big one; without it, expect 403.
    const postHeaders = {
      "Accept": "*/*",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      "Api-Version": "1",
      "Consumer-Key": MAERSK_CONSUMER_KEY,
      "Content-Type": "application/json",
      "Origin": "https://www.maersk.com",
      "Priority": "u=1, i",
      "Referer": "https://www.maersk.com/",
      "Sec-Ch-Ua": '"Brave";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-site",
      "Sec-Gpc": "1",
      "User-Agent": MAERSK_UA,
    };
    if (MAERSK_BM_TELEMETRY) {
      postHeaders["Akamai-Bm-Telemetry"] = MAERSK_BM_TELEMETRY;
    }

    const result = await httpsPostJsonMaersk(MAERSK_ROUTINGS_URL, payload, postHeaders);

    const totalElapsed = Date.now() - startTotal;
    console.log("[MAERSK] Response:", result.status, "size:", result.body.length, "elapsed:", totalElapsed + "ms");

    if (result.status !== 200) {
      // 403 likely means the Akamai Bot Manager rejected us — refresh the
      // telemetry token in Railway. Report diagnostics so we can tell the
      // user exactly what's configured.
      const isBotBlock = result.status === 403;
      return res.status(502).json({
        error: isBotBlock
          ? "Maersk blocked the request (HTTP 403) — likely Akamai Bot Manager. Refresh MAERSK_BM_TELEMETRY env var in Railway. See server.js comments for how to grab a fresh token."
          : `Maersk API returned HTTP ${result.status}`,
        status: result.status,
        elapsed: totalElapsed,
        botBlock: isBotBlock,
        diagnostics: {
          telemetryConfigured: !!MAERSK_BM_TELEMETRY,
          telemetryLength: MAERSK_BM_TELEMETRY.length,
          telemetryFirst30: MAERSK_BM_TELEMETRY.substring(0, 30),
          consumerKeyPresent: !!MAERSK_CONSUMER_KEY,
          startGeoId, endGeoId,
          responseBytes: result.body.length,
          responseStart: result.body.substring(0, 200),
        },
        preview: result.body.substring(0, 500),
      });
    }

    let json;
    try { json = JSON.parse(result.body); }
    catch (e) {
      return res.status(502).json({ error: "Maersk response not JSON", preview: result.body.substring(0, 500) });
    }

    const sailings = normalizeMaerskRoutings(json, polName, podName, pol, pod);

    if (debug) {
      return res.json({
        status: result.status,
        bodySize: result.body.length,
        elapsed: totalElapsed + "ms",
        sailingCount: sailings.length,
        startGeoId, endGeoId,
        firstSailing: sailings[0] || null,
        rawFirstRouting: (json.routings || [])[0] || null,
      });
    }

    if (sailings.length === 0) {
      return res.status(502).json({
        error: "No Maersk sailings found for this route in the selected time range.",
        status: result.status,
        routingsCount: (json.routings || []).length,
        startGeoId, endGeoId,
      });
    }

    console.log("[MAERSK] Parsed", sailings.length, "sailings in", totalElapsed + "ms");
    const responseData = {
      success: true, sailings, count: sailings.length,
      origin: polName.toUpperCase(), destination: podName.toUpperCase(),
      method: "maersk-public-api", elapsed: totalElapsed,
    };
    setMaerskCached(cacheKey, responseData);
    res.json(responseData);

  } catch (err) {
    console.error("[MAERSK] Error:", err.message);
    res.status(502).json({ error: "Maersk failed: " + err.message });
  }
});

// Diagnostic: Shanghai → Santos Maersk ping
app.get("/api/maersk-test", async (req, res) => {
  try {
    const startGeoId = await maerskLookupGeoId("CNSHA", "Shanghai");
    const endGeoId = await maerskLookupGeoId("BRSSZ", "Santos");
    res.json({
      ok: true,
      lookups: {
        CNSHA: startGeoId,
        BRSSZ: endGeoId,
      },
      cacheSize: MAERSK_GEO_CACHE.size,
      note: "✅ Maersk consumer-key working — GEO_ID lookup succeeded for both ports.",
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// =====================================================================
// === HMM via 2-step cookie-based flow ================================
// =====================================================================
// The HMM search is protected by Akamai Bot Manager (same as Maersk) plus
// an Oracle BMC load balancer and a Java session (JSESSIONID/WMONID). It
// also requires a CSRF token (x-csrf-token) obtained from an initial load
// of ScheduleMain.do.
//
// Fortunately, the search takes UN/LOCODEs directly (no GEO_ID mapping like
// Maersk), but it's a 2-step flow:
//   1) POST apiPointToPointList.do → returns a GrmNo (search ticket)
//   2) POST selectPointToPointList.do (with the GrmNo) → returns schedules
//
// HOW TO REFRESH (when searches start returning 403 / 500 / empty):
//  1. In a real browser, visit https://www.hmm21.com/e-service/general/schedule/ScheduleMain.do
//  2. Do any search so the cookies + CSRF are established
//  3. DevTools → Network → find apiPointToPointList.do → Copy as cURL
//  4. From the cURL extract:
//     - The whole `-b '...'` value → paste into Railway env HMM_COOKIES
//     - The `x-csrf-token: ...` header value → paste into Railway env HMM_CSRF_TOKEN
//  5. Save. Restart or let Railway auto-redeploy.
//
// Cookies include: WMONID, JSESSIONID, X-Oracle-BMC-LBS-Route, ak_bmsc, bm_sz,
// bm_sv, bm_mi, _abck. All are session-bound — if ANY drops off, expect 403.

// `let` (not const) so /api/cookies can hot-swap at runtime.
let HMM_COOKIES = (process.env.HMM_COOKIES || "")
  .replace(/[\r\n\t]+/g, "")
  .replace(/[\x00-\x1F\x7F]/g, "")
  .trim();
let HMM_CSRF_TOKEN = (process.env.HMM_CSRF_TOKEN || "")
  .replace(/[\r\n\t]+/g, "")
  .replace(/[\x00-\x1F\x7F]/g, "")
  .trim();

const HMM_ORIGIN = "https://www.hmm21.com";
const HMM_REFERER = "https://www.hmm21.com/e-service/general/schedule/ScheduleMain.do";
const HMM_APIPOINT_URL = "https://www.hmm21.com/e-service/general/schedule/apiPointToPointList.do";
const HMM_SELECTPOINT_URL = "https://www.hmm21.com/e-service/general/schedule/selectPointToPointList.do";
const HMM_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const HMM_CACHE = new Map();
const HMM_CACHE_TTL = 30 * 60 * 1000;

// Circuit breaker state: when HMM returns 403 or repeated timeouts, we flag
// the current cookie set as dead. Further requests short-circuit with a clear
// error instead of piling up 8s timeouts against a known-bad cookie.
// State resets on server restart (i.e. when env vars are refreshed in Railway).
const HMM_CIRCUIT = {
  dead: false,
  reason: "",
  deadAt: 0,
  consecutiveFailures: 0,
  // Cool-down window (ms) after which we allow ONE probe request through
  // to check if Akamai has forgiven us / admin refreshed cookies.
  coolDownMs: 5 * 60 * 1000,
};

function markHmmCookieDead(reason) {
  HMM_CIRCUIT.dead = true;
  HMM_CIRCUIT.reason = reason;
  HMM_CIRCUIT.deadAt = Date.now();
  console.log("[HMM] Circuit breaker TRIPPED:", reason);
}
function resetHmmCircuit() {
  if (HMM_CIRCUIT.dead) console.log("[HMM] Circuit breaker RESET");
  HMM_CIRCUIT.dead = false;
  HMM_CIRCUIT.reason = "";
  HMM_CIRCUIT.consecutiveFailures = 0;
}
function isHmmCircuitOpen() {
  if (!HMM_CIRCUIT.dead) return false;
  // Allow one probe every coolDownMs to detect recovery
  if (Date.now() - HMM_CIRCUIT.deadAt > HMM_CIRCUIT.coolDownMs) {
    console.log("[HMM] Circuit breaker cool-down elapsed — allowing one probe");
    HMM_CIRCUIT.deadAt = Date.now();  // reset cooldown timer
    return false;
  }
  return true;
}

function getHmmCached(key) {
  const e = HMM_CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.time > HMM_CACHE_TTL) { HMM_CACHE.delete(key); return null; }
  return e.data;
}
function setHmmCached(key, data) {
  HMM_CACHE.set(key, { time: Date.now(), data });
  if (HMM_CACHE.size > 100) {
    const now = Date.now();
    for (const [k, v] of HMM_CACHE.entries()) {
      if (now - v.time > HMM_CACHE_TTL) HMM_CACHE.delete(k);
    }
  }
}

// Common headers for both HMM POST steps. Replicates every header the browser
// sends — the Akamai bot manager fingerprints sec-fetch-*, sec-ch-ua*, etc.
function hmmHeaders(payloadLength) {
  return {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    "Content-Type": "application/json; charset=UTF-8",
    "Content-Length": payloadLength,
    "Cookie": HMM_COOKIES,
    "Origin": HMM_ORIGIN,
    "Priority": "u=1, i",
    "Referer": HMM_REFERER,
    "Sec-Ch-Ua": '"Brave";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Gpc": "1",
    "User-Agent": HMM_UA,
    "X-Csrf-Token": HMM_CSRF_TOKEN,
    "X-Requested-With": "XMLHttpRequest",
  };
}

// POST wrapper that handles gzip/br/deflate decoding + returns body as string.
// Same plumbing pattern as httpsPostJsonMaersk / cmaFetch.
// Timeout is 8s (not 30s): when Akamai tags a cookie as bot, it silently
// stalls requests. A short timeout surfaces the failure fast instead of
// letting the Express server pile up 30s pending connections.
function hmmPost(url, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(bodyObj);
    const headers = hmmHeaders(Buffer.byteLength(payload));
    const startTime = Date.now();

    const req = https.request({
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search, method: "POST",
      headers, timeout: 8000,
    }, (res) => {
      const encoding = res.headers["content-encoding"] || "";
      let stream = res;
      if (encoding === "gzip" || encoding === "x-gzip") {
        stream = res.pipe(require("zlib").createGunzip());
      } else if (encoding === "br") {
        stream = res.pipe(require("zlib").createBrotliDecompress());
      } else if (encoding === "deflate") {
        stream = res.pipe(require("zlib").createInflate());
      }
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
        elapsed: Date.now() - startTime,
      }));
      stream.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("HMM POST timeout (8s) — likely Akamai rate-limit on the current cookies")); });
    req.write(payload);
    req.end();
  });
}

// Format date as YYYYMMDD (what HMM srchSailDate expects)
function formatHmmDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

// Convert HMM date formats to ISO YYYY-MM-DD. HMM schedule responses use
// various forms: "20260519", "2026-05-19", "2026/05/19 13:00", etc.
function parseHmmDate(s) {
  if (!s) return "";
  const str = String(s).trim();
  const m1 = str.match(/^(\d{4})(\d{2})(\d{2})$/);           // 20260519
  if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;
  const m2 = str.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);    // 2026-05-19 or 2026/05/19
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  return "";
}

// Walk a nested object tree looking for an array of schedule-like items.
// HMM's selectPointToPointList response nests data deeply; we find the list
// heuristically (look for arrays where items have vessel/port fields).
function findSchedulesArray(obj, depth = 0) {
  if (!obj || depth > 8) return null;
  if (Array.isArray(obj)) {
    if (obj.length > 0 && typeof obj[0] === "object" && obj[0] &&
        (obj[0].mthVslNm || obj[0].porLocCd || obj[0].vslNm ||
         obj[0].polLocCd || obj[0].callSgnNo)) {
      return obj;
    }
    // Recurse into nested arrays too (in case of wrapper structures)
    for (const item of obj) {
      const found = findSchedulesArray(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof obj === "object") {
    // Known container field names in HMM responses
    const preferred = ["scheduleList", "list", "data", "resultData", "RTN_DATA", "transit"];
    for (const k of preferred) {
      if (obj[k]) {
        const found = findSchedulesArray(obj[k], depth + 1);
        if (found) return found;
      }
    }
    for (const k of Object.keys(obj)) {
      if (preferred.includes(k)) continue;
      const found = findSchedulesArray(obj[k], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// Convert a raw HMM schedule record into the shape the frontend expects.
// Schema discovered from real HMM response:
//   - root: schedule-level fields (mthVslNm, portCtofDt, totTrstmHrs, etc)
//   - root.transit[]: array of legs, each with CONTRA-INTUITIVE date names:
//       arvlStDt    = "Arrival Start"  = when vessel arrives at leg ORIGIN → ETD
//       dpartFnshDt = "Depart Finish"  = when vessel finishes at leg DEST   → ETA
//     (verified against hmm21.com UI: leg.arvlStDt matches "ETD" column;
//      leg.dpartFnshDt matches "ETB" column for the discharge port.)
//   - Cut-offs are at ROOT only: portCtofDt, fcgoCtofDt, fstRcveCtofDt, sigCtofDt
//   - Transshipment info: fstTrshpPortCd/scndTrshpPortCd/thrdTrshpPortCd at root,
//     or transit.length > 1 (T/S routes have multiple legs)
function normalizeHmmSchedule(r, polName, podName, polCode, podCode) {
  const vessel = r.mthVslNm || r.vslNm || r.vesselName || "TBN";
  const voyage = r.mthCssmObVoyNo || r.voyNo || r.voyageNo || "";
  const serviceCode = r.vslSvcLoopCd || r.mthLoopCd || "";
  const callSign = r.callSgnNo || r.callSign || "";
  const vvdCode = r.mthVvdCd || "";             // full voyage-vessel-dir ID
  const tradeCode = r.trdeCd || "";              // trade lane (e.g. "LA" = Latin America)
  const bisWeek = r.bisWk || "";                 // ISO business week
  const bisYear = r.bisYr || "";

  // Origin / destination
  const origin = r.porLocNm || r.polLocNm || polName.toUpperCase();
  const originCode = r.porLocCd || r.polLocCd || polCode;
  const polFacility = r.porFcltyNm || r.polFcltyNm || "";
  const destination = r.podLocNm || r.pvyLocNm || podName.toUpperCase();
  const destinationCode = r.podLocCd || r.pvyLocCd || podCode;
  const podFacility = r.podFcltyNm || r.pvyFcltyNm || "";

  // --- ETD / ETA from transit[] legs (the root doesn't carry these directly) ---
  const transitLegs = Array.isArray(r.transit) ? r.transit : [];

  // Pick the leg that corresponds to the POL (origin match) for ETD,
  // and the leg that corresponds to the POD (destination match) for ETA.
  // If no match, fall back to first/last leg in array order.
  const polLeg = transitLegs.find(l => (l.orgLocCd || "").toUpperCase() === (originCode || "").toUpperCase())
              || transitLegs[0];
  const podLeg = transitLegs.find(l => (l.destnLocCd || "").toUpperCase() === (destinationCode || "").toUpperCase())
              || transitLegs[transitLegs.length - 1];

  // CRITICAL: arvlStDt on the POL leg = when the vessel arrives at POL → ETD
  //           dpartFnshDt on the POD leg = when the vessel finishes at POD → ETA
  const etdRaw = polLeg ? (polLeg.arvlStDt || polLeg.dpartStDt || "") : "";
  const etaRaw = podLeg ? (podLeg.dpartFnshDt || podLeg.arvlFnshDt || "") : "";

  // IMPORTANT: the frontend renders dates via `new Date(s)` → `.getDate()` etc.
  // If we return just "YYYY-MM-DD" (no time), JavaScript interprets it as
  // UTC midnight, and any client in a negative TZ (e.g. Brazil, -3) will see
  // the date shifted to the PREVIOUS day. To avoid this, we return the FULL
  // datetime string (with hour), which JS interprets as LOCAL time → renders
  // correctly.
  // Example: HMM JUNIPER `arvlStDt: "2026-04-18T22:30:00"`
  //   - old behavior: departureDate="2026-04-18" → rendered as 17/Apr in BRT ❌
  //   - new behavior: departureDate="2026-04-18T22:30:00" → rendered as 18/Apr ✅
  const departureDate = etdRaw || "";
  const arrivalDate = etaRaw || "";

  // Transit time: root-level totTrstmHrs is the authoritative total in hours.
  // Only fall back to computed difference if missing.
  let transitTime = 0;
  const totHrs = parseInt(r.totTrstmHrs || "0", 10);
  if (totHrs > 0) {
    transitTime = Math.round(totHrs / 24);
  } else if (departureDate && arrivalDate) {
    transitTime = Math.round((new Date(arrivalDate) - new Date(departureDate)) / 86400000);
  }

  // Direct vs T/S
  const hasTs = !!(r.fstTrshpPortCd || r.scndTrshpPortCd || r.thrdTrshpPortCd)
             || transitLegs.length > 1;
  const isDirect = !hasTs;

  // Cut-offs (only meaningful at root, not in transit legs)
  const portCutoff = r.portCtofDt || "";
  const cargoCutoff = r.fcgoCtofDt || "";
  const firstReceiveCutoff = r.fstRcveCtofDt || "";
  const siCutoff = r.sigCtofDt || "";
  const vgmCutoff = r.vgmCtofDt || "";

  return {
    carrier: "HMM",
    vessel,
    service: serviceCode,
    serviceCode,
    voyageRef: voyage,
    vvdCode,
    callSign,
    tradeCode,
    bisWeek,
    bisYear,
    departureDate,
    arrivalDate,
    departureDateDisplay: departureDate,
    arrivalDateDisplay: arrivalDate,
    transitTime: transitTime || 0,
    isDirect,
    origin,
    originCode,
    destination,
    destinationCode,
    polFacility,
    podFacility,
    portCutoff,
    cargoCutoff,
    firstReceiveCutoff,
    siCutoff,
    vgmCutoff,
    grmNo: r.grmNo || "",
  };
}

// === HMM ENDPOINT ===
app.get("/api/hmm", async (req, res) => {
  const { pol, pod, polName, podName, weeks, coast, debug, nocache } = req.query;
  if (!pol || !pod || !polName || !podName) return res.status(400).json({ error: "Missing params" });

  const w = String(parseInt(weeks || "2", 10));
  const coastOption = coast || "WC";  // WC/EC — HMM splits some lanes by coast
  const cacheKey = `${pol}-${pod}-${w}-${coastOption}`;

  if (!debug && !nocache) {
    const cached = getHmmCached(cacheKey);
    if (cached) {
      console.log("[HMM] Cache HIT:", cacheKey);
      return res.json({ ...cached, cached: true });
    }
  }

  if (!HMM_COOKIES || !HMM_CSRF_TOKEN) {
    return res.status(500).json({
      error: "HMM_COOKIES and HMM_CSRF_TOKEN env vars must be configured. " +
             "Grab both from a real browser session at hmm21.com → Schedule Main → Network tab → " +
             "apiPointToPointList.do → Copy as cURL → extract cookie + x-csrf-token.",
    });
  }

  // Circuit breaker: if cookie is flagged as dead from a recent failure,
  // short-circuit immediately (unless cool-down has elapsed).
  if (isHmmCircuitOpen()) {
    return res.status(503).json({
      error: "HMM cookies are flagged as invalid after a recent failure. " +
             "Refresh HMM_COOKIES + HMM_CSRF_TOKEN env vars in Railway, then redeploy. " +
             `Reason: ${HMM_CIRCUIT.reason}`,
      circuitOpen: true,
      deadSinceMinutes: Math.round((Date.now() - HMM_CIRCUIT.deadAt) / 60000),
    });
  }

  const sailDate = formatHmmDate(new Date());

  try {
    const startTotal = Date.now();

    // --- STEP 1: apiPointToPointList.do → get the GrmNo (search ticket) ---
    const step1Body = {
      srchViewType: "L",
      srchPointFromCd: pol,
      srchCityFrom: "CY",
      srchPointToCd: pod,
      srchCityTo: "CY",
      srchSailDate: sailDate,
      srchSelWeeks: w,
      srchSelPriority: "A",
      srchSelSortBy: "D",
      srchPorFcltyCd: "",
      srchPvyFcltyCd: "",
      itemPolCd: "",
      itemPodCd: "",
      paramToday: sailDate,
    };

    console.log("[HMM] Step 1: apiPointToPointList", pol, "→", pod);
    const step1 = await hmmPost(HMM_APIPOINT_URL, step1Body);
    console.log("[HMM] Step 1 response:", step1.status, "elapsed:", step1.elapsed + "ms");

    const isStep1Block = step1.status === 403
      || (step1.body.length < 2000 && /bot|captcha|blocked|datadome|bm_/i.test(step1.body));

    if (step1.status !== 200 || isStep1Block) {
      if (isStep1Block) markHmmCookieDead(`Step 1 got HTTP ${step1.status} (bot-block)`);
      return res.status(502).json({
        error: isStep1Block
          ? "HMM blocked the request (HTTP 403 / Akamai Bot Manager) — refresh HMM_COOKIES and HMM_CSRF_TOKEN env vars in Railway. Further requests will be short-circuited for 5 minutes."
          : `HMM step 1 failed: HTTP ${step1.status}`,
        status: step1.status,
        step: 1,
        botBlock: isStep1Block,
        circuitTripped: isStep1Block,
        diagnostics: {
          cookiesLength: HMM_COOKIES.length,
          csrfTokenLength: HMM_CSRF_TOKEN.length,
          responseStart: step1.body.substring(0, 300),
        },
      });
    }

    let step1Json;
    try { step1Json = JSON.parse(step1.body); }
    catch (e) {
      return res.status(502).json({ error: "HMM step 1 response not JSON", preview: step1.body.substring(0, 500) });
    }

    // GrmNo is nested: { RTN_DATA: { resultData: { GrmNo: "..." } } }
    const grmNo = step1Json?.RTN_DATA?.resultData?.GrmNo
              || step1Json?.resultData?.GrmNo
              || step1Json?.GrmNo;
    if (!grmNo) {
      return res.status(502).json({
        error: "HMM step 1 returned no GrmNo — response format unexpected",
        step1Response: step1Json,
      });
    }

    // --- STEP 2: selectPointToPointList.do → get actual schedules using GrmNo ---
    const step2Body = {
      srchViewType: "L",
      srchGrmNo: grmNo,
      grmSeqs: "",
      srchSelPriority: "A",
      srchSelSortBy: "D",
      isNew: true,
      coastOption,
    };

    console.log("[HMM] Step 2: selectPointToPointList grmNo=", grmNo);
    const step2 = await hmmPost(HMM_SELECTPOINT_URL, step2Body);
    console.log("[HMM] Step 2 response:", step2.status, "size:", step2.body.length, "elapsed:", step2.elapsed + "ms");

    const isStep2Block = step2.status === 403;
    if (step2.status !== 200 || isStep2Block) {
      if (isStep2Block) markHmmCookieDead(`Step 2 got HTTP ${step2.status} (bot-block)`);
      return res.status(502).json({
        error: isStep2Block
          ? "HMM blocked step 2 (HTTP 403) — likely Akamai. Refresh env vars. Further requests will be short-circuited for 5 minutes."
          : `HMM step 2 failed: HTTP ${step2.status}`,
        status: step2.status,
        step: 2,
        grmNo,
        botBlock: isStep2Block,
        circuitTripped: isStep2Block,
        preview: step2.body.substring(0, 500),
      });
    }

    let step2Json;
    try { step2Json = JSON.parse(step2.body); }
    catch (e) {
      return res.status(502).json({ error: "HMM step 2 response not JSON", preview: step2.body.substring(0, 500) });
    }

    // Extract schedule array (heuristic walker handles various wrapper shapes)
    const scheduleArray = findSchedulesArray(step2Json) || [];
    const sailings = scheduleArray
      .map(r => normalizeHmmSchedule(r, polName, podName, pol, pod))
      // Drop duplicate entries (HMM sometimes returns repeated rows for legs)
      .filter((s, i, arr) => {
        const key = `${s.vessel}-${s.voyageRef}-${s.departureDate}-${s.arrivalDate}`;
        return arr.findIndex(x => `${x.vessel}-${x.voyageRef}-${x.departureDate}-${x.arrivalDate}` === key) === i;
      })
      .sort((a, b) => (a.departureDate || "").localeCompare(b.departureDate || ""));

    const totalElapsed = Date.now() - startTotal;

    if (debug) {
      return res.json({
        status: 200,
        elapsed: totalElapsed + "ms",
        step1BodySize: step1.body.length,
        step2BodySize: step2.body.length,
        grmNo,
        rawArrayLength: scheduleArray.length,
        sailingCount: sailings.length,
        firstRaw: scheduleArray[0] || null,
        firstNormalized: sailings[0] || null,
      });
    }

    if (sailings.length === 0) {
      return res.status(502).json({
        error: "No HMM sailings found for this route. Either no service exists or the response format needs a parser update.",
        grmNo,
        step2Preview: step2.body.substring(0, 800),
      });
    }

    console.log("[HMM] Parsed", sailings.length, "sailings in", totalElapsed + "ms");
    const responseData = {
      success: true, sailings, count: sailings.length,
      origin: polName.toUpperCase(), destination: podName.toUpperCase(),
      method: "hmm-2step-cookie", elapsed: totalElapsed, grmNo,
    };
    setHmmCached(cacheKey, responseData);
    resetHmmCircuit();  // successful end-to-end request → clear any stale failure state
    res.json(responseData);

  } catch (err) {
    console.error("[HMM] Error:", err.message);
    // Count consecutive failures; after 2 in a row (usually timeouts from Akamai
    // silently stalling known-bad cookies), trip the circuit.
    HMM_CIRCUIT.consecutiveFailures = (HMM_CIRCUIT.consecutiveFailures || 0) + 1;
    if (HMM_CIRCUIT.consecutiveFailures >= 2 && /timeout|ECONNRESET|ETIMEDOUT/i.test(err.message)) {
      markHmmCookieDead(`${HMM_CIRCUIT.consecutiveFailures} consecutive timeouts — likely dead cookies`);
    }
    res.status(502).json({
      error: "HMM failed: " + err.message,
      consecutiveFailures: HMM_CIRCUIT.consecutiveFailures,
      circuitTripped: HMM_CIRCUIT.dead,
    });
  }
});

// Diagnostic: Shanghai → Navegantes ping (same route used for capture)
app.get("/api/hmm-test", async (req, res) => {
  if (!HMM_COOKIES || !HMM_CSRF_TOKEN) {
    return res.status(500).json({ ok: false, error: "HMM_COOKIES and HMM_CSRF_TOKEN not configured" });
  }
  const sailDate = formatHmmDate(new Date());
  try {
    const step1 = await hmmPost(HMM_APIPOINT_URL, {
      srchViewType: "L",
      srchPointFromCd: "CNSHA", srchCityFrom: "CY",
      srchPointToCd: "BRNVT", srchCityTo: "CY",
      srchSailDate: sailDate, srchSelWeeks: "2",
      srchSelPriority: "A", srchSelSortBy: "D",
      srchPorFcltyCd: "", srchPvyFcltyCd: "",
      itemPolCd: "", itemPodCd: "",
      paramToday: sailDate,
    });

    const isBlock = step1.status === 403;
    let grmNo = null;
    try {
      const j = JSON.parse(step1.body);
      grmNo = j?.RTN_DATA?.resultData?.GrmNo || null;
    } catch (_) {}

    res.json({
      ok: step1.status === 200 && !!grmNo && !isBlock,
      status: step1.status,
      grmNo,
      elapsed: step1.elapsed + "ms",
      botBlock: isBlock,
      note: !HMM_CSRF_TOKEN
        ? "❌ HMM_CSRF_TOKEN not set"
        : isBlock
          ? "❌ Blocked by Akamai — refresh HMM_COOKIES + HMM_CSRF_TOKEN"
          : grmNo
            ? `✅ HMM cookies + CSRF working — step 1 returned GrmNo ${grmNo}`
            : "⚠️ Step 1 returned 200 but no GrmNo — response format may have changed",
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
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
    maerskConsumerKey: !!MAERSK_CONSUMER_KEY,
    maerskBmTelemetryConfigured: !!MAERSK_BM_TELEMETRY,
    maerskBmTelemetryLength: MAERSK_BM_TELEMETRY.length,
    maerskGeoCacheSize: MAERSK_GEO_CACHE.size,
    maerskScheduleCacheSize: MAERSK_CACHE.size,
    maerskMethod: "public-json-api",
    hmmCookiesConfigured: !!HMM_COOKIES,
    hmmCookiesLength: HMM_COOKIES.length,
    hmmCsrfConfigured: !!HMM_CSRF_TOKEN,
    hmmCsrfLength: HMM_CSRF_TOKEN.length,
    hmmCacheSize: HMM_CACHE.size,
    hmmMethod: "2step-cookie-csrf",
    hmmCircuitOpen: HMM_CIRCUIT.dead,
    hmmCircuitReason: HMM_CIRCUIT.reason || null,
    hmmConsecutiveFailures: HMM_CIRCUIT.consecutiveFailures,
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

// =====================================================================
// === MEUS FILTROS — persistent saved batch-search presets ============
// =====================================================================
// Stored as a flat JSON file on disk. Railway's ephemeral filesystem is a
// concern, but: (a) this file is re-created on write, (b) worst case a
// redeploy loses the filters, which the user accepts for simplicity.
// If we ever migrate to paid Railway with persistent volumes, path stays
// the same — just the underlying storage becomes durable.
// Schema matches what the frontend sends/expects:
//   [
//     { id, name, createdAt,
//       routes: [{carrier, pol, pod, polName, podName, polId, podId, maxResults}, ...] },
//     ...
//   ]

const FILTERS_FILE = path.join(__dirname, "filters.json");
const FILTERS_PASSWORD = "1234";  // shared password for create/delete (matches frontend)

function readFilters() {
  try {
    if (!fs.existsSync(FILTERS_FILE)) return [];
    const raw = fs.readFileSync(FILTERS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error("[FILTERS] Failed to read filters file:", e.message);
    return [];
  }
}

function writeFilters(list) {
  try {
    fs.writeFileSync(FILTERS_FILE, JSON.stringify(list, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error("[FILTERS] Failed to write filters file:", e.message);
    return false;
  }
}

// GET all filters — no auth needed, it's a read
app.get("/api/filters", (req, res) => {
  res.json(readFilters());
});

// POST a new filter — requires password in body
app.post("/api/filters", (req, res) => {
  const { password, filter } = req.body || {};
  if (password !== FILTERS_PASSWORD) {
    return res.status(401).json({ error: "Senha incorreta" });
  }
  if (!filter || !filter.name || !Array.isArray(filter.routes) || filter.routes.length === 0) {
    return res.status(400).json({ error: "Filter payload invalid (needs name + routes[])" });
  }
  // Sanitize: trim name, keep only expected fields on routes
  const clean = {
    id: filter.id || (String(Date.now()) + Math.random().toString(36).substring(2, 6)),
    name: String(filter.name).trim().substring(0, 100),
    createdAt: filter.createdAt || Date.now(),
    routes: filter.routes.map(r => ({
      carrier: String(r.carrier || "").toUpperCase().substring(0, 10),
      pol: String(r.pol || "").toUpperCase().substring(0, 5),
      pod: String(r.pod || "").toUpperCase().substring(0, 5),
      polName: String(r.polName || "").substring(0, 80),
      podName: String(r.podName || "").substring(0, 80),
      polId: r.polId ? parseInt(r.polId, 10) : null,
      podId: r.podId ? parseInt(r.podId, 10) : null,
      maxResults: Math.min(20, Math.max(1, parseInt(r.maxResults, 10) || 5)),
    })),
  };
  const list = readFilters();
  // If id already exists → replace (edit); otherwise append
  const idx = list.findIndex(f => f.id === clean.id);
  if (idx >= 0) list[idx] = clean; else list.push(clean);
  if (!writeFilters(list)) return res.status(500).json({ error: "Failed to persist filter" });
  res.json({ ok: true, filter: clean });
});

// DELETE a filter by id — requires password in query string (for simplicity)
app.delete("/api/filters/:id", (req, res) => {
  const { password } = req.query;
  if (password !== FILTERS_PASSWORD) {
    return res.status(401).json({ error: "Senha incorreta" });
  }
  const list = readFilters().filter(f => f.id !== req.params.id);
  if (!writeFilters(list)) return res.status(500).json({ error: "Failed to persist" });
  res.json({ ok: true });
});

// =====================================================================
// === COOKIES MANAGEMENT — hot-swap carrier credentials at runtime ===
// =====================================================================
// Lets the user update CMA/HMM/MAERSK cookies from within the app UI
// instead of having to edit env vars in Railway. Changes live only in
// memory for this process — they're lost on redeploy, at which point
// Railway env vars take over again. This is an ergonomic shortcut, NOT
// persistent storage.
//
// Security: same password gate as filters. This is a single-tenant app
// so the password is a light gate, not a real auth system.

const COOKIES_PASSWORD = "1234";

// Strip control chars + whitespace artifacts the same way the init code does
function sanitizeCookieString(s) {
  if (!s) return "";
  return String(s)
    .replace(/[\r\n\t]+/g, "")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .trim();
}

// GET — return status only (never the actual cookie values, for safety).
// The UI uses this to show "configured / not configured" badges per carrier.
app.get("/api/cookies", (req, res) => {
  res.json({
    cma: {
      configured: !!CMA_COOKIES,
      length: CMA_COOKIES.length,
      // Hash-ish preview (first few chars of datadome) to let user verify
      // they're looking at the right cookie without exposing the value.
      preview: (CMA_COOKIES.match(/datadome=([^;]+)/i) || [])[1]?.substring(0, 8) || "",
    },
    maersk: {
      configured: !!MAERSK_BM_TELEMETRY,
      length: MAERSK_BM_TELEMETRY.length,
    },
    hmm: {
      cookiesConfigured: !!HMM_COOKIES,
      cookiesLength: HMM_COOKIES.length,
      csrfConfigured: !!HMM_CSRF_TOKEN,
      csrfLength: HMM_CSRF_TOKEN.length,
    },
  });
});

// POST — accept { password, carrier, cookies, csrfToken? }
// Valid carriers: "cma" | "maersk" | "hmm"
// For "hmm", both cookies AND csrfToken must be supplied together.
app.post("/api/cookies", (req, res) => {
  const { password, carrier, cookies, csrfToken } = req.body || {};
  if (password !== COOKIES_PASSWORD) {
    return res.status(401).json({ error: "Senha incorreta" });
  }
  const car = String(carrier || "").toLowerCase();
  const clean = sanitizeCookieString(cookies || "");

  if (car === "cma") {
    if (!clean) return res.status(400).json({ error: "cookies string is empty after sanitize" });
    CMA_COOKIES = clean;
    console.log("[COOKIES] CMA_COOKIES updated via API →", clean.length, "chars");
    return res.json({ ok: true, carrier: "cma", length: clean.length });
  }
  if (car === "maersk") {
    if (!clean) return res.status(400).json({ error: "telemetry string is empty after sanitize" });
    MAERSK_BM_TELEMETRY = clean;
    console.log("[COOKIES] MAERSK_BM_TELEMETRY updated via API →", clean.length, "chars");
    return res.json({ ok: true, carrier: "maersk", length: clean.length });
  }
  if (car === "hmm") {
    const cleanCsrf = sanitizeCookieString(csrfToken || "");
    if (!clean || !cleanCsrf) {
      return res.status(400).json({ error: "HMM needs BOTH cookies and csrfToken" });
    }
    HMM_COOKIES = clean;
    HMM_CSRF_TOKEN = cleanCsrf;
    // Reset the circuit breaker — new creds deserve a fresh chance
    if (typeof resetHmmCircuit === "function") resetHmmCircuit();
    console.log("[COOKIES] HMM_COOKIES + HMM_CSRF_TOKEN updated via API →",
      clean.length, "chars cookies /", cleanCsrf.length, "chars csrf");
    return res.json({ ok: true, carrier: "hmm", cookiesLength: clean.length, csrfLength: cleanCsrf.length });
  }
  return res.status(400).json({ error: "Unknown carrier: " + carrier });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log("Next Sailings running on port " + PORT);
  console.log("CMA cookies:", CMA_COOKIES ? `CONFIGURED (${CMA_COOKIES.length} chars)` : "NOT CONFIGURED");
});
