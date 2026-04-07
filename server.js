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
// === CMA CGM via IPRoyal Web Unblocker ===
// =====================================================================
// Web Unblocker handles DataDome, captchas, fingerprinting, IP rotation,
// and automatic retries internally. We make ONE request to the export
// endpoint and they return the XLSX. No multi-step warm-up needed,
// no cookie jar needed, no sticky session needed.
//
// Set these env vars in Railway (replace the old residential ones):
//   PROXY_HOST = unblocker.iproyal.com
//   PROXY_PORT = 12323
//   PROXY_USER = your Web Unblocker username
//   PROXY_PASS = your Web Unblocker password

const PROXY_HOST = process.env.PROXY_HOST || "";
const PROXY_PORT = process.env.PROXY_PORT || "";
const PROXY_USER = process.env.PROXY_USER || "";
const PROXY_PASS = process.env.PROXY_PASS || "";

function getProxyAgent() {
  if (!PROXY_HOST || !PROXY_USER || !PROXY_PASS) return null;
  const proxyUrl = `http://${encodeURIComponent(PROXY_USER)}:${encodeURIComponent(PROXY_PASS)}@${PROXY_HOST}:${PROXY_PORT}`;
  return new HttpsProxyAgent(proxyUrl);
}

// Realistic Chrome 131 headers (Web Unblocker may override these but we send sensible defaults)
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Single-shot fetch through Web Unblocker. Returns { ok, status, body, contentType, elapsed }.
function unblockerFetch(targetUrl, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const agent = getProxyAgent();
    if (!agent) return reject(new Error("Web Unblocker proxy not configured"));

    const u = new URL(targetUrl);
    const startTime = Date.now();

    const reqOptions = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: "GET",
      agent,
      // Web Unblocker terminates TLS on its own servers (MITM) to inspect and
      // modify traffic for DataDome bypass. The cert it presents to us is NOT
      // the real cma-cgm.com cert — it's IPRoyal's own. Node rejects unknown
      // certs by default; we must tell it to trust this one. Scoped to this
      // function only — MSC and everything else still validates normally.
      rejectUnauthorized: false,
      headers: {
        "User-Agent": CHROME_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "gzip, deflate, br",
        Host: u.hostname,
        ...extraHeaders,
      },
      timeout: 180000, // 180s — Web Unblocker can take 60-150s on DataDome-protected binary endpoints
    };

    const req = https.request(reqOptions, (res) => {
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
          status, body: Buffer.concat(chunks),
          contentType, elapsed: Date.now() - startTime,
        });
      });
      stream.on("error", reject);
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Web Unblocker timeout (180s)")); });
    req.end();
  });
}

// === Cache to save Web Unblocker requests (each request costs $0.001) ===
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
    return res.status(500).json({ error: "Web Unblocker proxy not configured. Set PROXY_HOST, PROXY_PORT, PROXY_USER, PROXY_PASS env vars in Railway." });
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
    console.log("[CMA] Search via Web Unblocker:", pol, "->", pod, "weeks:", w);
    const startTotal = Date.now();

    const result = await unblockerFetch(exportUrl, {
      "Referer": "https://www.cma-cgm.com/ebusiness/schedules/routing-finder",
    });
    const totalElapsed = Date.now() - startTotal;
    console.log("[CMA] Total elapsed:", totalElapsed + "ms", "ok:", result.ok, "status:", result.status, "size:", result.body.length);

    if (!result.ok) {
      const preview = result.body.toString("utf8", 0, 300);
      return res.status(502).json({
        error: "Web Unblocker fetch failed",
        status: result.status,
        details: preview,
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
      method: "iproyal-web-unblocker", elapsed: totalElapsed,
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
    cmaMethod: "iproyal-web-unblocker",
  });
});

// Diagnostic: verify the Web Unblocker proxy is reachable and authenticating.
// Hits ipify through the unblocker — if it returns 200 + an IP, auth works.
app.get("/api/proxy-test", async (req, res) => {
  try {
    const result = await unblockerFetch("https://api.ipify.org/?format=json");
    let ip = "";
    try { ip = JSON.parse(result.body.toString("utf8")).ip || ""; } catch (e) {}
    res.json({
      ok: result.ok,
      status: result.status,
      ip,
      elapsed: result.elapsed + "ms",
      proxyHost: PROXY_HOST,
      proxyPort: PROXY_PORT,
      note: result.ok && ip
        ? "✅ Web Unblocker reachable, authenticated, and returning a residential IP — ready to test CMA"
        : "❌ Web Unblocker auth or reachability problem — check Railway env vars",
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Diagnostic: fetch ANY URL through Web Unblocker.
// Use this to test variations: simple homepage vs export endpoint vs other CMA paths.
// Example: /api/unblocker-test?url=https://www.cma-cgm.com/
app.get("/api/unblocker-test", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url query param" });
  try {
    console.log("[unblocker-test] Fetching:", url);
    const result = await unblockerFetch(url);
    const isXlsx = result.body.length > 1 && result.body[0] === 0x50 && result.body[1] === 0x4B;
    res.json({
      ok: result.ok,
      status: result.status,
      contentType: result.contentType,
      fileSize: result.body.length,
      headerHex: result.body.slice(0, 4).toString("hex"),
      isXlsx,
      elapsed: result.elapsed + "ms",
      preview: isXlsx ? "(binary XLSX)" : result.body.toString("utf8", 0, 800),
    });
  } catch (err) {
    res.status(502).json({ error: err.message, url });
  }
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log("Next Sailings running on port " + PORT);
  console.log("Web Unblocker proxy:", PROXY_HOST ? `${PROXY_HOST}:${PROXY_PORT}` : "NOT CONFIGURED");
});
