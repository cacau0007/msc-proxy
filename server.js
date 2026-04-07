const express = require("express");
const https = require("https");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ExcelJS = require("exceljs");
const { HttpsProxyAgent } = require("https-proxy-agent");

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
// === CMA CGM via IPRoyal Residential Proxy ===
// =====================================================================

// IPRoyal credentials from environment variables (set in Railway)
// Pay-As-You-Go basic plan: bare USER:PASS only — no country modifier
// (country requires premium tier and causes 407 Proxy Authentication Required).
// Sticky session (_session-XXX_lifetime-10m) IS supported on basic and is
// REQUIRED for DataDome compatibility — it forces the same residential IP
// across the entire multi-step flow so the cookies set in Step 1 remain
// valid in Steps 2 and 3.
const PROXY_HOST = process.env.PROXY_HOST || "";
const PROXY_PORT = process.env.PROXY_PORT || "";
const PROXY_USER = process.env.PROXY_USER || "";
const PROXY_PASS = process.env.PROXY_PASS || "";

function buildProxyUser(sessionId) {
  // Sticky session pins us to a single residential IP for ~10 minutes.
  // Without this, every request gets a different IP and DataDome rejects.
  if (sessionId) return `${PROXY_USER}_session-${sessionId}_lifetime-10m`;
  return PROXY_USER;
}

function getProxyAgent(sessionId) {
  if (!PROXY_HOST || !PROXY_USER || !PROXY_PASS) return null;
  const user = buildProxyUser(sessionId);
  const proxyUrl = `http://${encodeURIComponent(user)}:${encodeURIComponent(PROXY_PASS)}@${PROXY_HOST}:${PROXY_PORT}`;
  return new HttpsProxyAgent(proxyUrl);
}

// Realistic Chrome 131 headers
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CHROME_BASE_HEADERS = {
  "User-Agent": CHROME_UA,
  "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Upgrade-Insecure-Requests": "1",
};

// Cookie jar (per session) — Map<sessionId, Map<cookieName, cookieValue>>
const cookieJars = new Map();
function getJar(sessionId) {
  if (!cookieJars.has(sessionId)) cookieJars.set(sessionId, new Map());
  return cookieJars.get(sessionId);
}
function jarToString(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function ingestSetCookies(jar, setCookies) {
  if (!setCookies) return;
  for (const c of setCookies) {
    const first = c.split(";")[0];
    const eq = first.indexOf("=");
    if (eq > 0) {
      const name = first.substring(0, eq).trim();
      const value = first.substring(eq + 1).trim();
      if (name) jar.set(name, value);
    }
  }
}

// Multi-purpose proxy request: returns { status, body (Buffer), setCookies }
function proxyRequest(targetUrl, sessionId, options = {}) {
  return new Promise((resolve, reject) => {
    const agent = getProxyAgent(sessionId);
    if (!agent) return reject(new Error("Proxy not configured"));

    const u = new URL(targetUrl);
    const startTime = Date.now();
    const jar = getJar(sessionId);
    const cookieHeader = jarToString(jar);

    const reqOptions = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: options.method || "GET",
      agent,
      headers: {
        ...CHROME_BASE_HEADERS,
        Host: u.hostname,
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        ...(options.headers || {}),
      },
      timeout: 60000,
    };

    const req = https.request(reqOptions, (res) => {
      const status = res.statusCode;
      const setCookies = res.headers["set-cookie"] || [];
      ingestSetCookies(jar, setCookies);

      // Follow redirects automatically
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        const newUrl = new URL(res.headers.location, targetUrl).toString();
        return resolve(proxyRequest(newUrl, sessionId, options));
      }

      const chunks = [];
      let stream = res;
      const encoding = res.headers["content-encoding"] || "";
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

      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => {
        resolve({
          status, body: Buffer.concat(chunks),
          contentType: res.headers["content-type"] || "",
          elapsed: Date.now() - startTime,
        });
      });
      stream.on("error", reject);
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Proxy request timeout (60s)")); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// Multi-step CMA fetch via IPRoyal residential proxy.
// DataDome requires BOTH residential IP AND warm-up cookies from prior page visits.
// We learned the hard way: residential IP alone is rejected with a JS challenge
// because the `datadome` cookie isn't set. So we visit /schedules → /routing-finder
// → export, building up the cookie jar along the way.
async function fetchCmaExport(exportUrl) {
  const sessionId = "s" + Math.random().toString(36).slice(2, 12);
  console.log("[CMA] Multi-step fetch via residential proxy, session:", sessionId);

  // Step 1: Visit main schedules page (collects datadome + ASP cookies)
  console.log("[CMA] Step 1: GET /ebusiness/schedules");
  const r1 = await proxyRequest("https://www.cma-cgm.com/ebusiness/schedules", sessionId, {
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
    },
  });
  const jar1 = getJar(sessionId);
  console.log("[CMA] Step 1 result:", r1.status, "cookies:", jar1.size, "len:", r1.body.length);
  if (r1.status === 403 || r1.body.toString("utf8", 0, 200).includes("captcha")) {
    cookieJars.delete(sessionId);
    return { ok: false, status: r1.status, reason: "Step 1 blocked by DataDome", body: r1.body.toString("utf8", 0, 500) };
  }

  // Step 2: Visit routing finder page (more cookies, builds Referer chain)
  console.log("[CMA] Step 2: GET /ebusiness/schedules/routing-finder");
  const r2 = await proxyRequest("https://www.cma-cgm.com/ebusiness/schedules/routing-finder", sessionId, {
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-User": "?1",
      "Referer": "https://www.cma-cgm.com/ebusiness/schedules",
    },
  });
  const jar2 = getJar(sessionId);
  console.log("[CMA] Step 2 result:", r2.status, "cookies:", jar2.size, "len:", r2.body.length);
  if (r2.status === 403 || r2.body.toString("utf8", 0, 200).includes("captcha")) {
    cookieJars.delete(sessionId);
    return { ok: false, status: r2.status, reason: "Step 2 blocked by DataDome", body: r2.body.toString("utf8", 0, 500) };
  }

  // Step 3: GET the export endpoint with full cookie jar
  console.log("[CMA] Step 3: GET export");
  const r3 = await proxyRequest(exportUrl, sessionId, {
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-User": "?1",
      "Referer": "https://www.cma-cgm.com/ebusiness/schedules/routing-finder",
    },
  });
  console.log("[CMA] Step 3 result:", r3.status, "type:", r3.contentType, "size:", r3.body.length);

  // Cleanup session jar (free memory)
  cookieJars.delete(sessionId);

  if (r3.status !== 200) {
    return { ok: false, status: r3.status, reason: "Step 3 (export) failed", body: r3.body.toString("utf8", 0, 500) };
  }

  return { ok: true, status: r3.status, body: r3.body, contentType: r3.contentType };
}

// === Cache to save proxy bandwidth ===
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

// === XLSX parser ===
async function parseXlsx(filePath, polName, podName, polCode, podCode) {
  const sailings = [];
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) return sailings;

  let headerRow = 0;
  const headers = [];
  ws.eachRow((row, rowNum) => {
    if (headerRow > 0) return;
    const vals = [];
    row.eachCell((cell) => vals.push(String(cell.value || "").toLowerCase()));
    const text = vals.join(" ");
    if (text.includes("vessel") || text.includes("departure") || text.includes("service")) {
      headerRow = rowNum;
      row.eachCell((cell, colNum) => { headers[colNum] = String(cell.value || "").trim(); });
    }
  });

  if (headerRow === 0) {
    console.log("[CMA] No header row. Total rows:", ws.rowCount);
    ws.eachRow((row, rowNum) => {
      if (rowNum > 5) return;
      const vals = []; row.eachCell((cell) => vals.push(String(cell.value || "")));
      console.log("[CMA] Row", rowNum, ":", vals.join(" | ").substring(0, 200));
    });
    return sailings;
  }

  console.log("[CMA] Headers row", headerRow, ":", headers.filter(Boolean).join(" | "));

  function findCol(...names) {
    for (let c = 1; c < headers.length; c++) {
      if (!headers[c]) continue;
      const h = headers[c].toLowerCase();
      for (const n of names) { if (h.includes(n.toLowerCase())) return c; }
    }
    return -1;
  }

  const cVessel = findCol("vessel");
  const cService = findCol("service", "line");
  const cVoyage = findCol("voyage");
  const cDep = findCol("departure", "etd", "sailing");
  const cArr = findCol("arrival", "eta");
  const cTransit = findCol("transit", "tt");
  const cType = findCol("routing", "type", "direct");
  const cCo2 = findCol("co2", "carbon");

  function toISO(d) {
    if (!d) return "";
    if (d instanceof Date) return d.toISOString().split("T")[0];
    if (!isNaN(d) && Number(d) > 40000) {
      const date = new Date((Number(d) - 25569) * 86400000);
      return date.toISOString().split("T")[0];
    }
    const t = new Date(d);
    if (!isNaN(t) && t.getFullYear() > 2000) return t.toISOString().split("T")[0];
    const m2 = String(d).match(/(\d{1,2})[-/](\w{3})[-/](\d{4})/);
    if (m2) { const t2 = new Date(`${m2[2]} ${m2[1]}, ${m2[3]}`); if (!isNaN(t2)) return t2.toISOString().split("T")[0]; }
    return String(d);
  }

  ws.eachRow((row, rowNum) => {
    if (rowNum <= headerRow) return;
    const cell = (c) => c > 0 ? String(row.getCell(c).value || "").trim() : "";
    const cellRaw = (c) => c > 0 ? row.getCell(c).value : null;

    const vessel = cell(cVessel);
    const depRaw = cellRaw(cDep);
    if (!vessel && !depRaw) return;

    const service = cell(cService);
    const svcCode = (service.match(/\(([^)]+)\)\s*$/) || [])[1] || service;
    const voyageRef = cell(cVoyage);
    const arrRaw = cellRaw(cArr);
    const transitRaw = cell(cTransit);
    const typeRaw = cell(cType);

    const depDate = toISO(depRaw);
    const arrDate = toISO(arrRaw);
    const transitTime = parseInt(transitRaw) || (depDate && arrDate ? Math.round((new Date(arrDate) - new Date(depDate)) / 86400000) : 0);
    const isDirect = typeRaw ? typeRaw.toLowerCase().includes("direct") : true;

    sailings.push({
      carrier: "CMA CGM", vessel: vessel || "TBN", service, serviceCode: svcCode, voyageRef,
      departureDate: depDate, arrivalDate: arrDate,
      departureDateDisplay: String(depRaw || ""), arrivalDateDisplay: String(arrRaw || ""),
      transitTime, co2: cell(cCo2), isDirect, portCutoff: "",
      origin: polName.toUpperCase(), originCode: polCode,
      destination: podName.toUpperCase(), destinationCode: podCode,
    });
  });
  return sailings;
}

// === CMA ENDPOINT ===
app.get("/api/cma", async (req, res) => {
  const { pol, pod, polName, podName, weeks, debug, nocache } = req.query;
  if (!pol || !pod || !polName || !podName) return res.status(400).json({ error: "Missing params" });

  const w = weeks || "5";
  const polDesc = `${polName.toUpperCase()} ; ${pol.substring(0,2)} ; ${pol}`;
  const podDesc = `${podName.toUpperCase()} ; ${pod.substring(0,2)} ; ${pod}`;

  // Cache check (saves proxy bandwidth)
  const cacheKey = getCacheKey(pol, pod, w);
  if (!debug && !nocache) {
    const cached = getCached(cacheKey);
    if (cached) {
      console.log("[CMA] Cache HIT:", cacheKey);
      return res.json({ ...cached, cached: true });
    }
  }

  if (!PROXY_HOST || !PROXY_USER || !PROXY_PASS) {
    return res.status(500).json({ error: "Residential proxy not configured. Set PROXY_HOST, PROXY_PORT, PROXY_USER, PROXY_PASS env vars in Railway." });
  }

  const rangeMap = {"1":"OneWeek","2":"TwoWeeks","3":"ThreeWeeks","4":"FourWeeks","5":"FiveWeeks","6":"SixWeeks","7":"SevenWeeks","8":"EightWeeks","9":"NineWeeks","10":"TenWeeks"};
  const searchRange = rangeMap[w] || "FiveWeeks";

  const tomorrow = new Date(Date.now() + 86400000);
  const mm = String(tomorrow.getMonth() + 1).padStart(2, "0");
  const dd = String(tomorrow.getDate()).padStart(2, "0");
  const yyyy = tomorrow.getFullYear();
  const fromDate = `${mm}/${dd}/${yyyy} 00:00:00`;

  const exportUrl = `https://www.cma-cgm.com/ebusiness/schedules/routing-finder/export?polPlaceCode=${pol}&podPlaceCode=${pod}&polType=Port&podType=Port&isDeparture=True&fromDate=${encodeURIComponent(fromDate)}&searchRange=${searchRange}&brand=0&language=en-US&isGovernmentBooking=False&isEcoNeeded=False&fileType=CSV`;

  const tmpFile = path.join(os.tmpdir(), `cma_${Date.now()}_${Math.random().toString(36).slice(2,8)}.xlsx`);

  try {
    console.log("[CMA] Search via IPRoyal:", pol, "->", pod, "weeks:", w);
    const startTotal = Date.now();

    const result = await fetchCmaExport(exportUrl);
    const totalElapsed = Date.now() - startTotal;
    console.log("[CMA] Total elapsed:", totalElapsed + "ms", "ok:", result.ok);

    if (!result.ok) {
      return res.status(502).json({
        error: "CMA fetch failed: " + result.reason,
        status: result.status,
        details: result.body ? result.body.substring(0, 300) : "",
        elapsed: totalElapsed,
      });
    }

    // Write body to file
    fs.writeFileSync(tmpFile, result.body);
    const fileSize = result.body.length;

    // Verify XLSX magic bytes (PK)
    const isXlsx = result.body[0] === 0x50 && result.body[1] === 0x4B;
    const headerHex = result.body.slice(0, 4).toString("hex");

    if (debug) {
      let preview = "";
      if (!isXlsx) preview = result.body.toString("utf8", 0, 1500);
      try { fs.unlinkSync(tmpFile); } catch (e) {}
      return res.json({
        status: result.status, fileSize, elapsed: totalElapsed + "ms",
        isXlsx, headerHex, contentType: result.contentType,
        proxyConfigured: !!(PROXY_HOST && PROXY_USER),
        preview: isXlsx ? "(binary XLSX data — success!)" : preview,
      });
    }

    if (!isXlsx) {
      try { fs.unlinkSync(tmpFile); } catch (e) {}
      return res.status(502).json({
        error: "Response is not XLSX",
        contentType: result.contentType,
        preview: result.body.toString("utf8", 0, 300),
      });
    }

    const sailings = await parseXlsx(tmpFile, polName, podName, pol, pod);
    try { fs.unlinkSync(tmpFile); } catch (e) {}

    console.log("[CMA] Parsed", sailings.length, "sailings in", totalElapsed + "ms");
    const responseData = {
      success: true, sailings, count: sailings.length,
      origin: polDesc, destination: podDesc,
      method: "iproyal-residential-sticky-warmup", elapsed: totalElapsed,
    };
    setCached(cacheKey, responseData);
    res.json(responseData);

  } catch (err) {
    console.error("[CMA] Error:", err.message);
    try { fs.unlinkSync(tmpFile); } catch (e) {}
    res.status(502).json({ error: "CMA failed: " + err.message });
  }
});

// === HEALTH ===
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    mscSession: !!sessionCookies,
    proxyConfigured: !!(PROXY_HOST && PROXY_USER && PROXY_PASS),
    proxyHost: PROXY_HOST || "(not set)",
    proxyPort: PROXY_PORT || "(not set)",
    proxyUser: PROXY_USER ? PROXY_USER.substring(0, 4) + "***" : "(not set)",
    cmaCacheSize: CMA_CACHE.size,
    cmaCacheTTL: "30min",
    cmaMethod: "iproyal-residential-sticky-warmup",
  });
});

// Diagnostic: try 5 username formats to discover what IPRoyal basic plan accepts.
// Each variant tries to fetch ipify through the proxy. Status 200 = format works,
// 407 = rejected by IPRoyal auth. We compare IPs across the sticky variants to
// confirm whether sticky session actually pins the IP.
app.get("/api/proxy-test", async (req, res) => {
  const testSessionId = "diag" + Math.random().toString(36).slice(2, 8);

  // Helper: build a proxy agent with an arbitrary username and try ipify
  async function tryFormat(label, customUser) {
    return new Promise((resolve) => {
      const proxyUrl = `http://${encodeURIComponent(customUser)}:${encodeURIComponent(PROXY_PASS)}@${PROXY_HOST}:${PROXY_PORT}`;
      const agent = new HttpsProxyAgent(proxyUrl);
      const startTime = Date.now();
      const req = https.request({
        hostname: "api.ipify.org",
        port: 443,
        path: "/?format=json",
        method: "GET",
        agent,
        headers: { "User-Agent": CHROME_UA },
        timeout: 15000,
      }, (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let ip = "";
          try { ip = JSON.parse(body).ip || ""; } catch (e) {}
          resolve({ label, username: customUser, status: r.statusCode, ip, elapsed: Date.now() - startTime });
        });
        r.on("error", () => resolve({ label, username: customUser, status: r.statusCode, ip: "", elapsed: Date.now() - startTime, error: "stream error" }));
      });
      req.on("error", (e) => resolve({ label, username: customUser, status: 0, ip: "", elapsed: Date.now() - startTime, error: e.message }));
      req.on("timeout", () => { req.destroy(); resolve({ label, username: customUser, status: 0, ip: "", elapsed: Date.now() - startTime, error: "timeout" }); });
      req.end();
    });
  }

  try {
    // Run all 5 formats sequentially (so we can compare IPs from sticky variants)
    const r1 = await tryFormat("bare", PROXY_USER);
    const r2a = await tryFormat("session-only-A", `${PROXY_USER}_session-${testSessionId}`);
    const r2b = await tryFormat("session-only-B", `${PROXY_USER}_session-${testSessionId}`);
    const r3a = await tryFormat("session+lifetime-A", `${PROXY_USER}_session-${testSessionId}_lifetime-10m`);
    const r3b = await tryFormat("session+lifetime-B", `${PROXY_USER}_session-${testSessionId}_lifetime-10m`);
    const r4 = await tryFormat("dash-session", `${PROXY_USER}-session-${testSessionId}`);
    const r5 = await tryFormat("country-br", `${PROXY_USER}_country-br`);

    // Detect sticky behavior: if both same-session calls authenticated AND returned same IP
    const stickyOnlyWorks = r2a.status === 200 && r2b.status === 200 && r2a.ip && r2a.ip === r2b.ip;
    const stickyLifetimeWorks = r3a.status === 200 && r3b.status === 200 && r3a.ip && r3a.ip === r3b.ip;

    // Recommendation
    let recommendation;
    if (stickyLifetimeWorks) recommendation = "Use _session-XXX_lifetime-10m format";
    else if (stickyOnlyWorks) recommendation = "Use _session-XXX format (no lifetime suffix)";
    else if (r4.status === 200) recommendation = "Use -session-XXX (dash) format — verify stickiness with another test";
    else recommendation = "IPRoyal basic plan rejects ALL session modifiers — need plan upgrade or alternative approach";

    res.json({
      ok: true,
      results: [r1, r2a, r2b, r3a, r3b, r4, r5],
      analysis: {
        bareAuthWorks: r1.status === 200,
        sessionOnlyAuths: r2a.status === 200,
        sessionOnlyIsSticky: stickyOnlyWorks,
        sessionLifetimeAuths: r3a.status === 200,
        sessionLifetimeIsSticky: stickyLifetimeWorks,
        dashSessionAuths: r4.status === 200,
        countryAuths: r5.status === 200,
      },
      recommendation,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log("Next Sailings running on port " + PORT);
  console.log("IPRoyal proxy:", PROXY_HOST ? `${PROXY_HOST}:${PROXY_PORT}` : "NOT CONFIGURED");
});
