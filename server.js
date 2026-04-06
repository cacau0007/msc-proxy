const express = require("express");
const https = require("https");
const path = require("path");
const { execFile } = require("child_process");
const os = require("os");
const fs = require("fs");
const ExcelJS = require("exceljs");

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
    res.setHeader("Content-Type", "application/json"); res.send(result.data);
  } catch (err) { sessionCookies = ""; sessionTime = 0; res.status(502).json({ IsSuccess: false, Data: "MSC error: " + err.message }); }
});

// ======================================================================
// === CMA CGM — curl-impersonate + XLSX export endpoint ===
// ======================================================================

const CMA_JAR = path.join(os.tmpdir(), "cma_cookies.txt");
const CMA_TTL = 25 * 60 * 1000;
let cmaCookieTime = 0;
let CURL_BIN = "";

const C116_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36";
const C116_HEADERS = {
  "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  "Sec-Ch-Ua": '"Chromium";v="116", "Not)A;Brand";v="24", "Google Chrome";v="116"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Upgrade-Insecure-Requests": "1",
};

function findCurlBin() {
  if (CURL_BIN) return CURL_BIN;
  try {
    const dir = "/opt/curl-imp";
    const files = fs.readdirSync(dir);
    const desktop = files.filter(f => /^curl_chrome\d+$/.test(f)).sort((a, b) => {
      return parseInt(b.match(/\d+/)[0]) - parseInt(a.match(/\d+/)[0]);
    });
    console.log("[CMA] Desktop Chrome binaries:", desktop.join(", "));
    if (desktop.length > 0) { CURL_BIN = path.join(dir, desktop[0]); console.log("[CMA] Selected:", CURL_BIN); return CURL_BIN; }
  } catch (e) {}
  CURL_BIN = "curl";
  console.log("[CMA] WARNING: using system curl");
  return CURL_BIN;
}

// curl-impersonate: download binary file to disk
function curlDownload(url, outFile, headers = {}) {
  return new Promise((resolve, reject) => {
    const bin = findCurlBin();
    const args = ["-s", "-L", "--max-redirs", "5", "-b", CMA_JAR, "-c", CMA_JAR, "-o", outFile, "-w", "%{http_code}"];
    for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
    args.push(url);
    execFile(bin, args, { timeout: 45000, env: { ...process.env, LD_LIBRARY_PATH: "/opt/curl-imp" } },
      (err, stdout) => {
        if (err && !stdout) return reject(err);
        resolve({ status: parseInt(stdout || "0") });
      }
    );
  });
}

// curl-impersonate: get text response
function curlText(url, options = {}) {
  return new Promise((resolve, reject) => {
    const bin = findCurlBin();
    const args = ["-s", "-L", "--max-redirs", "5", "-b", CMA_JAR, "-c", CMA_JAR];
    if (options.method === "POST") args.push("-X", "POST");
    for (const [k, v] of Object.entries(options.headers || {})) args.push("-H", `${k}: ${v}`);
    if (options.body) args.push("--data-raw", options.body);
    args.push("-w", "\n__ST__%{http_code}");
    args.push(url);
    execFile(bin, args, { maxBuffer: 20 * 1024 * 1024, timeout: 45000, env: { ...process.env, LD_LIBRARY_PATH: "/opt/curl-imp" } },
      (err, stdout) => {
        if (err && !stdout) return reject(err);
        const m = (stdout || "").match(/__ST__(\d+)$/);
        resolve({ status: m ? parseInt(m[1]) : 0, body: (stdout || "").replace(/\n__ST__\d+$/, "") });
      }
    );
  });
}

// Get fresh session cookies from CMA
async function refreshCmaCookies() {
  console.log("[CMA] Getting session cookies...");
  try { fs.unlinkSync(CMA_JAR); } catch (e) {}
  const r = await curlText("https://www.cma-cgm.com/ebusiness/schedules", {
    headers: { ...C116_HEADERS, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" },
  });
  console.log("[CMA] Session page:", r.status, "len:", r.body.length, "captcha:", r.body.includes("captcha"));
  cmaCookieTime = Date.now();
  return r;
}

// Parse XLSX export into sailing objects
async function parseXlsx(filePath, polName, podName, polCode, podCode) {
  const sailings = [];
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) return sailings;

  // Find header row (first row with "vessel" or "departure" in it)
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
    console.log("[CMA] No header row found in XLSX. Rows:", ws.rowCount);
    // Dump first 5 rows for debugging
    ws.eachRow((row, rowNum) => {
      if (rowNum > 5) return;
      const vals = []; row.eachCell((cell) => vals.push(String(cell.value || ""))); 
      console.log("[CMA] Row", rowNum, ":", vals.join(" | "));
    });
    return sailings;
  }

  console.log("[CMA] Headers at row", headerRow, ":", headers.filter(Boolean).join(", "));

  // Map headers to column indices
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
  const cPol = findCol("pol", "origin", "loading");
  const cPod = findCol("pod", "destination", "discharge");
  const cCo2 = findCol("co2", "carbon");

  console.log("[CMA] Columns: vessel=", cVessel, "service=", cService, "dep=", cDep, "arr=", cArr, "transit=", cTransit);

  // Read data rows
  ws.eachRow((row, rowNum) => {
    if (rowNum <= headerRow) return;
    const cell = (c) => c > 0 ? String(row.getCell(c).value || "").trim() : "";

    const vessel = cell(cVessel) || "TBN";
    if (!vessel || vessel === "TBN" && !cell(cDep)) return; // Skip empty rows

    const service = cell(cService);
    const svcCode = (service.match(/\(([^)]+)\)\s*$/) || [])[1] || service;
    const voyageRef = cell(cVoyage);
    const depRaw = cell(cDep);
    const arrRaw = cell(cArr);
    const transitRaw = cell(cTransit);
    const typeRaw = cell(cType);
    const co2Raw = cell(cCo2);

    // Parse dates
    function toISO(d) {
      if (!d) return "";
      // Handle Excel date serial numbers
      if (!isNaN(d) && Number(d) > 40000) {
        const date = new Date((Number(d) - 25569) * 86400000);
        return date.toISOString().split("T")[0];
      }
      const t = new Date(d);
      if (!isNaN(t) && t.getFullYear() > 2000) return t.toISOString().split("T")[0];
      // Try dd-MMM-yyyy
      const m2 = String(d).match(/(\d{1,2})[-/](\w{3})[-/](\d{4})/);
      if (m2) { const t2 = new Date(`${m2[2]} ${m2[1]}, ${m2[3]}`); if (!isNaN(t2)) return t2.toISOString().split("T")[0]; }
      return String(d);
    }

    const depDate = toISO(depRaw);
    const arrDate = toISO(arrRaw);
    const transitTime = parseInt(transitRaw) || (depDate && arrDate ? Math.round((new Date(arrDate) - new Date(depDate)) / 86400000) : 0);
    const isDirect = typeRaw ? typeRaw.toLowerCase().includes("direct") : true;

    sailings.push({
      carrier: "CMA CGM", vessel, service, serviceCode: svcCode, voyageRef,
      departureDate: depDate, arrivalDate: arrDate,
      departureDateDisplay: depRaw, arrivalDateDisplay: arrRaw,
      transitTime, co2: co2Raw, isDirect, portCutoff: "",
      origin: polName.toUpperCase(), originCode: polCode,
      destination: podName.toUpperCase(), destinationCode: podCode,
    });
  });

  return sailings;
}

// Also keep HTML parser as fallback
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
        origin: polName.toUpperCase(), originCode: polCode, destination: podName.toUpperCase(), destinationCode: podCode,
      });
    } catch (e) { continue; }
  }
  return sailings;
}

// === CMA ENDPOINT ===
app.get("/api/cma", async (req, res) => {
  const { pol, pod, polName, podName, weeks, debug } = req.query;
  if (!pol || !pod || !polName || !podName) return res.status(400).json({ error: "Missing params" });

  const w = weeks || "5";
  const polDesc = `${polName.toUpperCase()} ; ${pol.substring(0,2)} ; ${pol}`;
  const podDesc = `${podName.toUpperCase()} ; ${pod.substring(0,2)} ; ${pod}`;
  const rangeMap = {"1":"OneWeek","2":"TwoWeeks","3":"ThreeWeeks","4":"FourWeeks","5":"FiveWeeks","6":"SixWeeks","7":"SevenWeeks","8":"EightWeeks","9":"NineWeeks","10":"TenWeeks"};
  const searchRange = rangeMap[w] || "FiveWeeks";

  try {
    // Ensure cookies
    if (!cmaCookieTime || Date.now() - cmaCookieTime > CMA_TTL) await refreshCmaCookies();

    const tomorrow = new Date(Date.now() + 86400000);
    const mm = String(tomorrow.getMonth() + 1).padStart(2, "0");
    const dd = String(tomorrow.getDate()).padStart(2, "0");
    const yyyy = tomorrow.getFullYear();
    const fromDate = `${mm}/${dd}/${yyyy} 00:00:00`;

    // Strategy 1: Try XLSX export endpoint
    const exportUrl = `https://www.cma-cgm.com/ebusiness/schedules/routing-finder/export?polPlaceCode=${pol}&podPlaceCode=${pod}&polType=Port&podType=Port&isDeparture=True&fromDate=${encodeURIComponent(fromDate)}&searchRange=${searchRange}&brand=0&language=en-US&isGovernmentBooking=False&isEcoNeeded=False&fileType=CSV`;

    const tmpFile = path.join(os.tmpdir(), `cma_export_${Date.now()}.xlsx`);

    console.log("[CMA] Trying export endpoint:", pol, "->", pod);

    const dlResult = await curlDownload(exportUrl, tmpFile, {
      ...C116_HEADERS,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Referer": "https://www.cma-cgm.com/ebusiness/schedules/routing-finder",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
    });

    console.log("[CMA] Export status:", dlResult.status);

    // Check if file exists and is not a captcha page
    let fileSize = 0;
    let isBinary = false;
    try {
      const stat = fs.statSync(tmpFile);
      fileSize = stat.size;
      // Check first bytes - PK = ZIP/XLSX, <html = captcha
      const header = Buffer.alloc(4);
      const fd = fs.openSync(tmpFile, "r");
      fs.readSync(fd, header, 0, 4, 0);
      fs.closeSync(fd);
      isBinary = header[0] === 0x50 && header[1] === 0x4B; // PK magic bytes
      console.log("[CMA] File size:", fileSize, "is XLSX:", isBinary, "header:", header.toString("hex"));
    } catch (e) { console.log("[CMA] File check error:", e.message); }

    if (debug) {
      let firstBytes = "";
      try { firstBytes = fs.readFileSync(tmpFile, "utf8").substring(0, 1000); } catch (e) {}
      try { fs.unlinkSync(tmpFile); } catch (e) {}
      return res.json({
        status: dlResult.status, fileSize, isBinary,
        curlBin: CURL_BIN,
        hasCaptcha: firstBytes.includes("captcha") || firstBytes.includes("challenge"),
        first500: isBinary ? "(binary XLSX data)" : firstBytes.substring(0, 500),
      });
    }

    if (isBinary && fileSize > 500) {
      // SUCCESS! Parse XLSX
      console.log("[CMA] Parsing XLSX export...");
      const sailings = await parseXlsx(tmpFile, polName, podName, pol, pod);
      try { fs.unlinkSync(tmpFile); } catch (e) {}
      console.log("[CMA] Parsed", sailings.length, "sailings from XLSX");
      return res.json({ success: true, sailings, count: sailings.length, method: "xlsx", origin: polDesc, destination: podDesc });
    }

    // Export was blocked — try HTML form POST as fallback
    console.log("[CMA] Export blocked/empty, trying HTML form POST...");
    try { fs.unlinkSync(tmpFile); } catch (e) {}

    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const searchDate = `${String(tomorrow.getDate()).padStart(2,"0")}-${months[tomorrow.getMonth()]}-${tomorrow.getFullYear()}`;
    const formData = `ActualPOLDescription=${encodeURIComponent(polDesc)}&ActualPODDescription=${encodeURIComponent(podDesc)}&ActualPOLType=Port&ActualPODType=Port&polDescription=${encodeURIComponent(polDesc)}&podDescription=${encodeURIComponent(podDesc)}&IsDeparture=True&SearchDate=${encodeURIComponent(searchDate)}&searchRange=${w}`;

    const htmlResult = await curlText("https://www.cma-cgm.com/ebusiness/schedules/routing-finder", {
      method: "POST",
      headers: { ...C116_HEADERS, "Content-Type": "application/x-www-form-urlencoded", "Origin": "https://www.cma-cgm.com",
        "Referer": "https://www.cma-cgm.com/ebusiness/schedules/routing-finder", "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "same-origin" },
      body: formData,
    });

    console.log("[CMA] HTML result:", htmlResult.status, "len:", htmlResult.body.length, "cards:", htmlResult.body.includes("cardelem"));

    if (htmlResult.body.includes("cardelem")) {
      const sailings = parseCmaHtml(htmlResult.body, polName, podName, pol, pod);
      return res.json({ success: true, sailings, count: sailings.length, method: "html", origin: polDesc, destination: podDesc });
    }

    // Both failed
    cmaCookieTime = 0;
    return res.status(502).json({ error: "CMA CGM blocked both export and HTML. DataDome active." });

  } catch (err) {
    console.error("[CMA] Error:", err.message);
    cmaCookieTime = 0;
    res.status(502).json({ error: "CMA request failed: " + err.message });
  }
});

// === HEALTH ===
app.get("/api/health", (req, res) => {
  let bins = [];
  try { bins = fs.readdirSync("/opt/curl-imp").filter(f => f.startsWith("curl_") && !f.includes(".")); } catch (e) {}
  res.json({ status: "ok", mscSession: !!sessionCookies, curlBin: CURL_BIN || findCurlBin(), availableBins: bins,
    cmaCookieAge: cmaCookieTime ? Math.round((Date.now() - cmaCookieTime) / 1000) + "s" : "none" });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => { console.log("Next Sailings running on port " + PORT); findCurlBin(); });
