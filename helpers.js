// helpers.js — shared HTTP and session utilities used by both server.js
// (for schedules) and trackers.js (for tracking). Extracted so trackers.js
// can be self-contained without circular requires.

const https = require("https");
const zlib = require("zlib");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// More browser-realistic UA used for CMA tracking, mirroring the one in
// server.js's existing schedule scraper. DataDome fingerprints the UA, so
// we keep the schedule and tracking scrapers using the same string.
const CMA_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

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

// Generic POST with form-urlencoded body. Used by CMA tracking which expects
// classic form posts, not JSON. Handles gzip/br/deflate transparently like
// the CMA schedule scraper in server.js does. Caller controls all headers
// (so they can pass Cookie, Referer, etc).
function httpPostForm(url, formData, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = Object.entries(formData)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    const startTime = Date.now();
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ""),
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      const status = res.statusCode;
      const contentType = res.headers["content-type"] || "";
      const encoding = res.headers["content-encoding"] || "";

      let stream = res;
      if (encoding === "gzip" || encoding === "x-gzip") {
        stream = res.pipe(zlib.createGunzip());
      } else if (encoding === "br") {
        stream = res.pipe(zlib.createBrotliDecompress());
      } else if (encoding === "deflate") {
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
    req.on("timeout", () => { req.destroy(); reject(new Error("POST timeout (30s)")); });
    req.write(body);
    req.end();
  });
}

// === MSC session cookie management ===
// MSC's tracking API works fine with cookies obtained from any MSC page; the
// schedules page gets us a session that's valid for /api/feature/tools/* in
// general. Cached for SESSION_TTL ms and refreshed on demand.
const MSC_PAGE = "https://www.msc.com/en/search-a-schedule";
const SESSION_TTL = 30 * 60 * 1000; // 30 min — well under cookie expiration
let _mscSession = null;
let _mscSessionTime = 0;

async function getMscSession() {
  if (_mscSession && Date.now() - _mscSessionTime < SESSION_TTL) return _mscSession;
  const res = await httpGet(MSC_PAGE, { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" });
  _mscSession = (res.setCookies || []).map(c => c.split(";")[0]).join("; ");
  _mscSessionTime = Date.now();
  return _mscSession;
}

// Force refresh — useful when a 403 indicates the cookie is stale.
function clearMscSession() {
  _mscSession = null;
  _mscSessionTime = 0;
}

// === CMA cookie store ===
// CMA schedules and tracking share the same DataDome-protected domain, so
// they share the same cookie string. server.js owns the canonical value
// (loaded from process.env.CMA_COOKIES + hot-swappable via /api/cookies),
// and pushes updates here via setCmaCookies. trackers.js reads via
// getCmaCookies. Initialized from env so trackers.js works even on cold
// start before server.js has touched it.
let _cmaCookies = (process.env.CMA_COOKIES || "")
  .replace(/[\r\n\t]+/g, "")
  .replace(/[\x00-\x1F\x7F]/g, "")
  .trim();

function getCmaCookies() {
  return _cmaCookies;
}

function setCmaCookies(value) {
  _cmaCookies = (value || "")
    .replace(/[\r\n\t]+/g, "")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .trim();
}

module.exports = {
  UA,
  CMA_UA,
  httpGet,
  httpPostJson,
  httpPostForm,
  getMscSession,
  clearMscSession,
  getCmaCookies,
  setCmaCookies,
};
