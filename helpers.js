// helpers.js — shared HTTP and session utilities used by both server.js
// (for schedules) and trackers.js (for tracking). Extracted so trackers.js
// can be self-contained without circular requires.

const https = require("https");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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

module.exports = {
  UA,
  httpGet,
  httpPostJson,
  getMscSession,
  clearMscSession,
};
