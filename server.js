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
const PROXY_HOST = process.env.PROXY_HOST || "";
const PROXY_PORT = process.env.PROXY_PORT || "";
const PROXY_USER = process.env.PROXY_USER || "";
const PROXY_PASS = process.env.PROXY_PASS || "";

function getProxyAgent() {
  if (!PROXY_HOST || !PROXY_USER || !PROXY_PASS) return null;
  const proxyUrl = `http://${encodeURIComponent(PROXY_USER)}:${encodeURIComponent(PROXY_PASS)}@${PROXY_HOST}:${PROXY_PORT}`;
  return new HttpsProxyAgent(proxyUrl);
}

// HTTPS GET through residential proxy, downloading binary to file
function proxyDownload(targetUrl, outFile, headers = {}) {
  return new Promise((resolve, reject) => {
    const agent = getProxyAgent();
    if (!agent) return reject(new Error("Proxy credentials not configured"));

    const startTime = Date.now();
    const u = new URL(targetUrl);

    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: "GET",
      agent,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "identity",
        "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Upgrade-Insecure-Requests": "1",
        "Referer": "https://www.cma-cgm.com/ebusiness/schedules/routing-finder",
        ...headers,
      },
      timeout: 60000,
    }, (res) => {
      const status = res.statusCode;

      if (status !== 200) {
        let errBody = "";
        res.on("data", (c) => (errBody += c.toString()));
        res.on("end", () => resolve({ status, error: errBody.substring(0, 500), elapsed: Date.now() - startTime }));
        return;
      }

      const file = fs.createWriteStream(outFile);
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        try {
          const stat = fs.statSync(outFile);
          resolve({ status, fileSize: stat.size, elapsed: Date.now() - startTime });
        } catch (e) {
          resolve({ status, fileSize: 0, error: e.message, elapsed: Date.now() - startTime });
        }
      });
      file.on("error", (err) => {
        try { fs.unlinkSync(outFile); } catch (e) {}
        reject(err);
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Proxy request timeout (60s)"));
    });
    req.end();
  });
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

    const result = await proxyDownload(exportUrl, tmpFile);
    console.log("[CMA] Proxy result: status=" + result.status, "size=" + (result.fileSize || 0), "elapsed=" + result.elapsed + "ms");

    if (result.status !== 200 || !result.fileSize) {
      try { fs.unlinkSync(tmpFile); } catch (e) {}
      return res.status(502).json({
        error: "Proxy fetch failed: status " + result.status,
        details: result.error || "no body",
        elapsed: result.elapsed,
      });
    }

    // Verify XLSX magic bytes (PK)
    const header = Buffer.alloc(4);
    const fd = fs.openSync(tmpFile, "r");
    fs.readSync(fd, header, 0, 4, 0);
    fs.closeSync(fd);
    const isXlsx = header[0] === 0x50 && header[1] === 0x4B;

    if (debug) {
      let preview = "";
      if (!isXlsx) { try { preview = fs.readFileSync(tmpFile, "utf8").substring(0, 1000); } catch (e) {} }
      try { fs.unlinkSync(tmpFile); } catch (e) {}
      return res.json({
        status: result.status, fileSize: result.fileSize, elapsed: result.elapsed + "ms",
        isXlsx, headerHex: header.toString("hex"),
        proxyConfigured: !!(PROXY_HOST && PROXY_USER),
        preview: isXlsx ? "(binary XLSX data — success!)" : preview,
      });
    }

    if (!isXlsx) {
      try { fs.unlinkSync(tmpFile); } catch (e) {}
      return res.status(502).json({ error: "Response is not XLSX (DataDome may have blocked even residential IP — try again)" });
    }

    const sailings = await parseXlsx(tmpFile, polName, podName, pol, pod);
    try { fs.unlinkSync(tmpFile); } catch (e) {}

    console.log("[CMA] Parsed", sailings.length, "sailings in", result.elapsed + "ms");
    const responseData = {
      success: true, sailings, count: sailings.length,
      origin: polDesc, destination: podDesc,
      method: "iproyal-residential", elapsed: result.elapsed,
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
  });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log("Next Sailings running on port " + PORT);
  console.log("IPRoyal proxy:", PROXY_HOST ? `${PROXY_HOST}:${PROXY_PORT}` : "NOT CONFIGURED");
});
