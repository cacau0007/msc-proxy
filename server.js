const express = require("express");
const https = require("https");
const path = require("path");
const { execFile } = require("child_process");
const os = require("os");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.static(path.join(__dirname, "public")));

// === MSC CONFIG (UNCHANGED) ===
const MSC_API = "https://www.msc.com/api/feature/tools/SearchSailingRoutes";
const MSC_PAGE = "https://www.msc.com/en/search-a-schedule";
const DATA_SOURCE_ID = "{E9CCBD25-6FBA-4C5C-85F6-FC4F9E5A931F}";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let sessionCookies = "";
let sessionTime = 0;
const SESSION_TTL = 15 * 60 * 1000;

// === MSC HTTP HELPERS (UNCHANGED) ===
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
      headers: { ...headers, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
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

// === MSC SESSION (UNCHANGED) ===
async function getSession() {
  if (sessionCookies && Date.now() - sessionTime < SESSION_TTL) return sessionCookies;
  console.log("[MSC] Getting new session...");
  const res = await httpGet(MSC_PAGE, { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" });
  console.log("[MSC] Page status:", res.status, "cookies:", res.setCookies.length);
  sessionCookies = res.setCookies.map((c) => c.split(";")[0]).join("; ");
  sessionTime = Date.now();
  return sessionCookies;
}

// === MSC SCHEDULES (UNCHANGED) ===
app.get("/api/schedules", async (req, res) => {
  const { fromPortId, toPortId } = req.query;
  if (!fromPortId || !toPortId) return res.status(400).json({ IsSuccess: false, Data: "Missing fromPortId or toPortId" });
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

// ======================================================================
// === CMA CGM — curl-impersonate (Chrome TLS fingerprint) ===
// ======================================================================

const CMA_COOKIE_FILE = path.join(os.tmpdir(), "cma_cookies.txt");
const CMA_COOKIE_TTL = 8 * 60 * 1000;
let cmaCookieTime = 0;
let CURL_BIN = "";

function findCurlBin() {
  if (CURL_BIN) return CURL_BIN;
  // Search for any curl_chrome* binary
  try {
    const dir = "/opt/curl-imp";
    const files = fs.readdirSync(dir).filter(f => f.startsWith("curl_chrome") && !f.includes(".")).sort().reverse();
    if (files.length > 0) { CURL_BIN = path.join(dir, files[0]); console.log("[CMA] curl-impersonate found:", CURL_BIN); return CURL_BIN; }
  } catch (e) {}
  // Fallback to PATH
  try { execFile("curl_chrome116", ["--version"], { timeout: 3000 }, () => {}); CURL_BIN = "curl_chrome116"; return CURL_BIN; } catch (e) {}
  CURL_BIN = "curl"; console.log("[CMA] WARNING: curl-impersonate not found, using system curl");
  return CURL_BIN;
}

function curlChrome(url, options = {}) {
  return new Promise((resolve, reject) => {
    const bin = findCurlBin();
    const args = ["-s"];
    if (options.followRedirects !== false) { args.push("-L"); args.push("--max-redirs", "5"); }
    args.push("-b", CMA_COOKIE_FILE, "-c", CMA_COOKIE_FILE);
    if (options.method === "POST") args.push("-X", "POST");
    const hdrs = options.headers || {};
    for (const [k, v] of Object.entries(hdrs)) args.push("-H", `${k}: ${v}`);
    if (options.body) args.push("--data-raw", options.body);
    args.push("-w", "\n__CURL_STATUS__%{http_code}");
    args.push(url);

    execFile(bin, args, { maxBuffer: 20 * 1024 * 1024, timeout: 45000, env: { ...process.env, LD_LIBRARY_PATH: "/opt/curl-imp" } },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(err);
        const sm = (stdout || "").match(/__CURL_STATUS__(\d+)$/);
        const status = sm ? parseInt(sm[1]) : 0;
        const body = (stdout || "").replace(/\n__CURL_STATUS__\d+$/, "");
        resolve({ status, body });
      }
    );
  });
}

async function refreshCmaCookies() {
  console.log("[CMA] Refreshing cookies with curl-impersonate...");
  try { fs.unlinkSync(CMA_COOKIE_FILE); } catch (e) {}
  const r = await curlChrome("https://www.cma-cgm.com/ebusiness/schedules", {
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none",
      "Upgrade-Insecure-Requests": "1",
    },
  });
  console.log("[CMA] Cookie page status:", r.status, "len:", r.body.length, "captcha:", r.body.includes("captcha"), "schedule:", r.body.includes("Routing"));
  cmaCookieTime = Date.now();
  return r;
}

function parseCmaHtml(html, polName, podName, polCode, podCode) {
  const sailings = [];
  if (!html || !html.includes("cardelem")) return sailings;
  const cards = html.split('<li class="cardelem ');
  for (let i = 1; i < cards.length; i++) {
    const card = cards[i];
    try {
      const depM = card.match(/DepartureDatesCls" data-event-date="([^"]+)"/); if (!depM) continue;
      const arrM = card.match(/ArrivalDatesCls" data-event-date="([^"]+)"/);
      const dateMs = [...card.matchAll(/<span class="date">([^<]+)<\/span>/g)];
      const vesM = card.match(/<dt>Main vessel<\/dt>\s*<dd>([^<]+)<\/dd>/);
      const svcM = card.match(/alt='name of the line'>([^<]+)<\/a>/);
      const service = svcM ? svcM[1].trim() : "";
      const svcCode = (service.match(/\(([^)]+)\)\s*$/) || [])[1] || service;
      const voyM = card.match(/voyageReference=([^"&]+)/);
      const ttM = card.match(/Transitcls" data-value="(\d+)"/);
      const co2M = card.match(/TotalCo2Cls" data-value="([^"]+)"/);
      const cutM = card.match(/<dt>Port Cut-off<\/dt>\s*<dd>([^<]+)<\/dd>/);
      const dep = depM[1], arr = arrM ? arrM[1] : "";
      let depISO = "", arrISO = "";
      if (dep) { const [m, d, y] = dep.split("/"); depISO = `${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`; }
      if (arr) { const [m, d, y] = arr.split("/"); arrISO = `${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`; }
      sailings.push({
        carrier: "CMA CGM", vessel: vesM ? vesM[1].trim() : "TBN", service, serviceCode: svcCode,
        voyageRef: voyM ? voyM[1] : "", departureDate: depISO, arrivalDate: arrISO,
        departureDateDisplay: dateMs[0] ? dateMs[0][1].trim() : "", arrivalDateDisplay: dateMs[1] ? dateMs[1][1].trim() : "",
        transitTime: ttM ? parseInt(ttM[1]) : 0, co2: co2M ? co2M[1] : "",
        isDirect: card.includes('"transit direct"'), portCutoff: cutM ? cutM[1].trim() : "",
        origin: polName.toUpperCase(), originCode: polCode, destination: podName.toUpperCase(), destinationCode: podCode,
      });
    } catch (e) { continue; }
  }
  return sailings;
}

app.get("/api/cma", async (req, res) => {
  const { pol, pod, polName, podName, weeks, debug } = req.query;
  if (!pol || !pod || !polName || !podName) return res.status(400).json({ error: "Missing pol, pod, polName, podName" });

  const w = weeks || "5";
  const polCC = pol.substring(0, 2), podCC = pod.substring(0, 2);
  const polDesc = `${polName.toUpperCase()} ; ${polCC} ; ${pol}`;
  const podDesc = `${podName.toUpperCase()} ; ${podCC} ; ${pod}`;

  try {
    if (!cmaCookieTime || Date.now() - cmaCookieTime > CMA_COOKIE_TTL) await refreshCmaCookies();

    const tomorrow = new Date(Date.now() + 86400000);
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const searchDate = `${String(tomorrow.getDate()).padStart(2,"0")}-${months[tomorrow.getMonth()]}-${tomorrow.getFullYear()}`;

    const formData = `ActualPOLDescription=${encodeURIComponent(polDesc)}&ActualPODDescription=${encodeURIComponent(podDesc)}&ActualPOLType=Port&ActualPODType=Port&polDescription=${encodeURIComponent(polDesc)}&podDescription=${encodeURIComponent(podDesc)}&IsDeparture=True&SearchDate=${encodeURIComponent(searchDate)}&searchRange=${w}`;

    console.log("[CMA] POST", pol, "->", pod, "date:", searchDate);

    const result = await curlChrome("https://www.cma-cgm.com/ebusiness/schedules/routing-finder", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "https://www.cma-cgm.com",
        "Referer": "https://www.cma-cgm.com/ebusiness/schedules/routing-finder",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "same-origin",
        "Upgrade-Insecure-Requests": "1",
      },
      body: formData,
    });

    console.log("[CMA] Result:", result.status, "len:", result.body.length);

    if (debug) {
      return res.json({
        status: result.status, bodyLength: result.body.length,
        hasCardelem: result.body.includes("cardelem"), hasSchedule: result.body.includes("Schedule results"),
        hasCaptcha: result.body.includes("captcha") || result.body.includes("challenge"),
        curlBin: CURL_BIN, first3000: result.body.substring(0, 3000),
      });
    }

    // If blocked, retry with fresh cookies
    if (result.status === 403 || result.body.includes("captcha")) {
      cmaCookieTime = 0;
      try { fs.unlinkSync(CMA_COOKIE_FILE); } catch (e) {}
      console.log("[CMA] Blocked, retrying...");
      await refreshCmaCookies();
      const r2 = await curlChrome("https://www.cma-cgm.com/ebusiness/schedules/routing-finder", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Origin": "https://www.cma-cgm.com", "Referer": "https://www.cma-cgm.com/ebusiness/schedules/routing-finder", "Accept": "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7" }, body: formData,
      });
      if (r2.status === 403 || r2.body.includes("captcha")) return res.status(502).json({ error: "CMA CGM blocked (DataDome). curl-impersonate could not bypass." });
      const s2 = parseCmaHtml(r2.body, polName, podName, pol, pod);
      return res.json({ success: true, sailings: s2, count: s2.length, origin: polDesc, destination: podDesc });
    }

    const sailings = parseCmaHtml(result.body, polName, podName, pol, pod);
    res.json({ success: true, sailings, count: sailings.length, origin: polDesc, destination: podDesc });
  } catch (err) {
    console.error("[CMA] Error:", err.message);
    cmaCookieTime = 0;
    res.status(502).json({ error: "CMA request failed: " + err.message });
  }
});

// === HEALTH ===
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", mscSession: !!sessionCookies, curlBin: CURL_BIN || findCurlBin(), cmaCookieAge: cmaCookieTime ? Math.round((Date.now() - cmaCookieTime) / 1000) + "s" : "none" });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log("Next Sailings running on port " + PORT);
  findCurlBin();
});
