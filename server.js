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
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: "POST", headers: { ...headers, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, (res) => {
      let data = ""; res.on("data", (c) => (data += c)); res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", reject); req.write(payload); req.end();
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
    const result = await httpPost(MSC_API, { FromDate: fromDate, fromPortId: parseInt(fromPortId), toPortId: parseInt(toPortId), language: "en", dataSourceId: DATA_SOURCE_ID }, {
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

// ======================================================================
// === CMA CGM — curl-impersonate + DataDome challenge solver ===
// ======================================================================

const CMA_JAR = path.join(os.tmpdir(), "cma_cookies.txt");
const CMA_TTL = 25 * 60 * 1000; // 25 min cookie cache
let cmaCookieTime = 0;
let CURL_BIN = "";

// Chrome 116 desktop headers — MUST match the curl_chrome116 TLS fingerprint
const C116_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36";
const C116_HEADERS = {
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  "Sec-Ch-Ua": '"Chromium";v="116", "Not)A;Brand";v="24", "Google Chrome";v="116"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Upgrade-Insecure-Requests": "1",
};

// Find DESKTOP Chrome binary (exclude _android, _edge, _ff, _safari)
function findCurlBin() {
  if (CURL_BIN) return CURL_BIN;
  try {
    const dir = "/opt/curl-imp";
    const files = fs.readdirSync(dir);
    // Filter: only curl_chromeNNN (desktop), no _android/_edge etc
    const chromeDesktop = files
      .filter(f => /^curl_chrome\d+$/.test(f))
      .sort((a, b) => {
        const na = parseInt(a.match(/\d+/)[0]);
        const nb = parseInt(b.match(/\d+/)[0]);
        return nb - na; // highest version first
      });
    console.log("[CMA] Available desktop Chrome binaries:", chromeDesktop.join(", "));
    console.log("[CMA] All curl binaries:", files.filter(f => f.startsWith("curl_") && !f.includes(".")).join(", "));
    if (chromeDesktop.length > 0) {
      CURL_BIN = path.join(dir, chromeDesktop[0]);
      console.log("[CMA] Selected:", CURL_BIN);
      return CURL_BIN;
    }
  } catch (e) { console.log("[CMA] Dir scan error:", e.message); }
  CURL_BIN = "curl";
  console.log("[CMA] WARNING: No curl-impersonate found, using system curl");
  return CURL_BIN;
}

// Execute curl-impersonate
function curlExec(url, options = {}) {
  return new Promise((resolve, reject) => {
    const bin = findCurlBin();
    const args = ["-s", "-L", "--max-redirs", "5", "-b", CMA_JAR, "-c", CMA_JAR];
    if (options.method === "POST") args.push("-X", "POST");
    for (const [k, v] of Object.entries(options.headers || {})) args.push("-H", `${k}: ${v}`);
    if (options.body) args.push("--data-raw", options.body);
    args.push("-w", "\n__STATUS__%{http_code}");
    args.push(url);

    execFile(bin, args, {
      maxBuffer: 20 * 1024 * 1024, timeout: 45000,
      env: { ...process.env, LD_LIBRARY_PATH: "/opt/curl-imp" },
    }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      const m = (stdout || "").match(/__STATUS__(\d+)$/);
      resolve({ status: m ? parseInt(m[1]) : 0, body: (stdout || "").replace(/\n__STATUS__\d+$/, "") });
    });
  });
}

// Read a cookie value from Netscape cookie jar file
function readCookie(name) {
  try {
    const jar = fs.readFileSync(CMA_JAR, "utf8");
    for (const line of jar.split("\n")) {
      const parts = line.split("\t");
      if (parts.length >= 7 && parts[5] === name) return parts[6].trim();
    }
  } catch (e) {}
  return "";
}

// Write a cookie to the Netscape cookie jar file
function writeCookie(domain, name, value) {
  try {
    let jar = "";
    try { jar = fs.readFileSync(CMA_JAR, "utf8"); } catch (e) { jar = "# Netscape HTTP Cookie File\n"; }
    // Remove old cookie with same name+domain
    const lines = jar.split("\n").filter(l => {
      const p = l.split("\t");
      return !(p.length >= 7 && p[5] === name && p[0].includes(domain.replace(/^\./, "")));
    });
    // Add new cookie (expire in 1 year)
    const exp = Math.floor(Date.now() / 1000) + 31536000;
    lines.push(`${domain}\tTRUE\t/\tTRUE\t${exp}\t${name}\t${value}`);
    fs.writeFileSync(CMA_JAR, lines.join("\n") + "\n");
    return true;
  } catch (e) { return false; }
}

// Parse dd={...} from DataDome challenge HTML
function parseDD(html) {
  const m = html.match(/var\s+dd\s*=\s*\{([^}]+)\}/);
  if (!m) return null;
  const obj = {};
  const pairs = m[1].match(/'([^']+)'\s*:\s*'([^']*)'/g) || [];
  for (const p of pairs) {
    const kv = p.match(/'([^']+)'\s*:\s*'([^']*)'/);
    if (kv) obj[kv[1]] = kv[2];
  }
  return obj;
}

// Build browser fingerprint for DataDome API
function buildJsData() {
  return JSON.stringify({
    ttst: 34.5 + Math.random() * 10,
    ifov: false, wdif: false, wdifrm: false, npmtm: false,
    hc: 8, br: "Chrome",
    ua: C116_UA,
    wbd: false, dp: 0, tagpu: 26.8 + Math.random() * 5, tproc: 16,
    bcda: false, bcdapi: false,
    nddc: 1, nclad: 0, cpts: "0",
    ling: "pt-BR", dnlg: "pt-BR",
    br_h: 937, br_w: 1920, br_oh: 1040, br_ow: 1920,
    rs_h: 1080, rs_w: 1920, rs_cd: 24,
    phe: false, nm: false, jsf: false,
    lg: "pt-BR", pr: 1,
    ars_h: 1040, ars_w: 1920,
    tz: -180,
    str_ss: true, str_ls: true, str_idb: true, str_odb: true,
    plg: [
      { name: "PDF Viewer", description: "Portable Document Format", filename: "internal-pdf-viewer" },
      { name: "Chrome PDF Viewer", description: "Portable Document Format", filename: "internal-pdf-viewer" },
    ],
    fnt: ["Arial","Courier New","Georgia","Times New Roman","Verdana"],
    mem: 8, cvs: true, pmp: 0, lgs: true,
    tch: false, act: "unknown", dnt: false, conn: "4g",
  });
}

// === DATADOME CHALLENGE SOLVER ===
async function solveCmaDataDome() {
  // Step 1: Clear old cookies
  try { fs.unlinkSync(CMA_JAR); } catch (e) {}

  console.log("[CMA] Step 1: GET page with curl-impersonate...");
  const page = await curlExec("https://www.cma-cgm.com/ebusiness/schedules", {
    headers: { ...C116_HEADERS, "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" },
  });
  console.log("[CMA] Page status:", page.status, "len:", page.body.length);

  // If page loaded fine (no captcha), we're done
  if (page.status === 200 && page.body.includes("Routing") && !page.body.includes("captcha-delivery")) {
    console.log("[CMA] Page loaded without DataDome challenge!");
    cmaCookieTime = Date.now();
    return true;
  }

  // Step 2: Parse DataDome challenge parameters
  const dd = parseDD(page.body);
  if (!dd || !dd.cid) {
    console.log("[CMA] Could not parse DataDome challenge params");
    return false;
  }
  console.log("[CMA] Step 2: DataDome challenge found. cid:", dd.cid.substring(0, 20) + "...", "ddk:", dd.hsh);

  // Step 3: Read initial datadome cookie (set by first request)
  const initialDD = readCookie("datadome");
  console.log("[CMA] Initial datadome cookie:", initialDD ? initialDD.substring(0, 30) + "..." : "none");

  // Step 4: POST to DataDome API to solve challenge
  console.log("[CMA] Step 3: Solving DataDome challenge via API...");
  const jsData = buildJsData();
  const solveBody = [
    `jsData=${encodeURIComponent(jsData)}`,
    `eventCounters=${encodeURIComponent("[]")}`,
    `jsType=ch`,
    `cid=${encodeURIComponent(dd.cid)}`,
    `ddk=${encodeURIComponent(dd.hsh)}`,
    `Referer=${encodeURIComponent("https://www.cma-cgm.com/ebusiness/schedules")}`,
    `request=${encodeURIComponent("/ebusiness/schedules")}`,
    `responsePage=origin`,
    `ddv=4.23.0`,
  ].join("&");

  const solve = await curlExec("https://api-js.datadome.co/js/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "*/*",
      "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "Origin": "https://geo.captcha-delivery.com",
      "Referer": "https://geo.captcha-delivery.com/",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "cross-site",
      ...({ "Sec-Ch-Ua": C116_HEADERS["Sec-Ch-Ua"], "Sec-Ch-Ua-Mobile": "?0", "Sec-Ch-Ua-Platform": '"Windows"' }),
    },
    body: solveBody,
  });

  console.log("[CMA] DataDome API status:", solve.status, "len:", solve.body.length);
  console.log("[CMA] DataDome response:", solve.body.substring(0, 500));

  // Step 5: Parse response and save cookie
  try {
    const data = JSON.parse(solve.body);
    if (data.cookie) {
      const cookieMatch = data.cookie.match(/datadome=([^;]+)/);
      if (cookieMatch) {
        writeCookie(".cma-cgm.com", "datadome", cookieMatch[1]);
        console.log("[CMA] DataDome cookie saved successfully!");
        cmaCookieTime = Date.now();
        return true;
      }
    }
    if (data.url) {
      console.log("[CMA] DataDome requires CAPTCHA (harder challenge):", data.url.substring(0, 100));
      return false;
    }
  } catch (e) {
    console.log("[CMA] Could not parse DataDome response:", e.message);
  }

  // Step 6: Even if JSON parse failed, check if cookie jar was updated via Set-Cookie header
  const ddCookie = readCookie("datadome");
  if (ddCookie && ddCookie !== initialDD) {
    console.log("[CMA] Cookie updated via headers!");
    cmaCookieTime = Date.now();
    return true;
  }

  return false;
}

// === CMA HTML PARSER ===
function parseCmaHtml(html, polName, podName, polCode, podCode) {
  const sailings = [];
  if (!html || !html.includes("cardelem")) return sailings;
  const cards = html.split('<li class="cardelem ');
  for (let i = 1; i < cards.length; i++) {
    const c = cards[i];
    try {
      const depM = c.match(/DepartureDatesCls" data-event-date="([^"]+)"/); if (!depM) continue;
      const arrM = c.match(/ArrivalDatesCls" data-event-date="([^"]+)"/);
      const dMs = [...c.matchAll(/<span class="date">([^<]+)<\/span>/g)];
      const vesM = c.match(/<dt>Main vessel<\/dt>\s*<dd>([^<]+)<\/dd>/);
      const svcM = c.match(/alt='name of the line'>([^<]+)<\/a>/);
      const svc = svcM ? svcM[1].trim() : "";
      const svcCode = (svc.match(/\(([^)]+)\)\s*$/) || [])[1] || svc;
      const voyM = c.match(/voyageReference=([^"&]+)/);
      const ttM = c.match(/Transitcls" data-value="(\d+)"/);
      const co2M = c.match(/TotalCo2Cls" data-value="([^"]+)"/);
      const cutM = c.match(/<dt>Port Cut-off<\/dt>\s*<dd>([^<]+)<\/dd>/);
      const dep = depM[1], arr = arrM ? arrM[1] : "";
      let depISO = "", arrISO = "";
      if (dep) { const [m, d, y] = dep.split("/"); depISO = `${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`; }
      if (arr) { const [m, d, y] = arr.split("/"); arrISO = `${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`; }
      sailings.push({
        carrier: "CMA CGM", vessel: vesM ? vesM[1].trim() : "TBN", service: svc, serviceCode: svcCode,
        voyageRef: voyM ? voyM[1] : "", departureDate: depISO, arrivalDate: arrISO,
        departureDateDisplay: dMs[0] ? dMs[0][1].trim() : "", arrivalDateDisplay: dMs[1] ? dMs[1][1].trim() : "",
        transitTime: ttM ? parseInt(ttM[1]) : 0, co2: co2M ? co2M[1] : "",
        isDirect: c.includes('"transit direct"'), portCutoff: cutM ? cutM[1].trim() : "",
        origin: polName.toUpperCase(), originCode: polCode,
        destination: podName.toUpperCase(), destinationCode: podCode,
      });
    } catch (e) { continue; }
  }
  return sailings;
}

// === CMA CGM ENDPOINT ===
app.get("/api/cma", async (req, res) => {
  const { pol, pod, polName, podName, weeks, debug } = req.query;
  if (!pol || !pod || !polName || !podName) return res.status(400).json({ error: "Missing params" });

  const w = weeks || "5";
  const polDesc = `${polName.toUpperCase()} ; ${pol.substring(0,2)} ; ${pol}`;
  const podDesc = `${podName.toUpperCase()} ; ${pod.substring(0,2)} ; ${pod}`;

  try {
    // Ensure valid cookies
    if (!cmaCookieTime || Date.now() - cmaCookieTime > CMA_TTL) {
      const solved = await solveCmaDataDome();
      if (!solved) {
        return res.status(502).json({ error: "Could not bypass DataDome. Challenge requires browser." });
      }
    }

    // Build search
    const tomorrow = new Date(Date.now() + 86400000);
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const searchDate = `${String(tomorrow.getDate()).padStart(2,"0")}-${months[tomorrow.getMonth()]}-${tomorrow.getFullYear()}`;
    const formData = `ActualPOLDescription=${encodeURIComponent(polDesc)}&ActualPODDescription=${encodeURIComponent(podDesc)}&ActualPOLType=Port&ActualPODType=Port&polDescription=${encodeURIComponent(polDesc)}&podDescription=${encodeURIComponent(podDesc)}&IsDeparture=True&SearchDate=${encodeURIComponent(searchDate)}&searchRange=${w}`;

    console.log("[CMA] Searching", pol, "->", pod);

    const result = await curlExec("https://www.cma-cgm.com/ebusiness/schedules/routing-finder", {
      method: "POST",
      headers: {
        ...C116_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "https://www.cma-cgm.com",
        "Referer": "https://www.cma-cgm.com/ebusiness/schedules/routing-finder",
        "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "same-origin",
      },
      body: formData,
    });

    console.log("[CMA] Search result:", result.status, "len:", result.body.length, "cards:", result.body.includes("cardelem"));

    if (debug) {
      return res.json({
        status: result.status, bodyLength: result.body.length,
        hasCards: result.body.includes("cardelem"), hasSchedule: result.body.includes("Schedule results"),
        hasCaptcha: result.body.includes("captcha"), curlBin: CURL_BIN,
        ddCookie: readCookie("datadome") ? "present" : "missing",
        first3000: result.body.substring(0, 3000),
      });
    }

    // If blocked again, try once more
    if (result.status === 403 || result.body.includes("captcha-delivery")) {
      console.log("[CMA] Blocked on search, re-solving...");
      cmaCookieTime = 0;
      const solved = await solveCmaDataDome();
      if (!solved) return res.status(502).json({ error: "DataDome blocked search request." });

      const r2 = await curlExec("https://www.cma-cgm.com/ebusiness/schedules/routing-finder", {
        method: "POST",
        headers: { ...C116_HEADERS, "Content-Type": "application/x-www-form-urlencoded", "Origin": "https://www.cma-cgm.com", "Referer": "https://www.cma-cgm.com/ebusiness/schedules/routing-finder" },
        body: formData,
      });
      if (r2.body.includes("captcha")) return res.status(502).json({ error: "DataDome still blocking." });
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

// === DIAGNOSTICS ===
app.get("/api/health", (req, res) => {
  let bins = [];
  try { bins = fs.readdirSync("/opt/curl-imp").filter(f => f.startsWith("curl_") && !f.includes(".")); } catch (e) {}
  res.json({
    status: "ok", mscSession: !!sessionCookies,
    curlBin: CURL_BIN || findCurlBin(),
    availableBins: bins,
    cmaCookieAge: cmaCookieTime ? Math.round((Date.now() - cmaCookieTime) / 1000) + "s" : "none",
    ddCookie: readCookie("datadome") ? "present" : "missing",
  });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log("Next Sailings running on port " + PORT);
  findCurlBin();
});
