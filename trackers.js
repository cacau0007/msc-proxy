/**
 * trackers.js — Universal tracking module for all carriers.
 *
 * Each carrier has 3 tracker functions: bookingTrack, mblTrack, cntrTrack.
 * They all share the same SHAPE so the frontend can render any response
 * with one normalize function.
 *
 * To plug in a real API:
 *   1. Find the function (e.g. mscBookingTrack)
 *   2. Replace the `return notImplemented(...)` with real fetch logic
 *   3. Map the API's response to the standard shape (see normalizedShape below)
 *   4. Done — the frontend already knows how to render it.
 *
 * IMPORTANT — when any tracker fails (network error, no result, API down),
 * it MUST return { ok: false, error: "..." } so the frontend can ignore it
 * silently. NEVER throw — the parallel orchestrator below catches and
 * normalizes everything, but explicit { ok:false } is faster.
 */

/**
 * STANDARD RESPONSE SHAPE
 * -----------------------
 * Successful tracking response should be:
 * {
 *   ok: true,
 *   carrier: "MSC",                          // canonical carrier code
 *   reference: "SNT1234567",                 // the input that was tracked
 *   referenceType: "booking" | "mbl" | "cntr",
 *
 *   // ===== HEADER (always shown) =====
 *   vessel: "MSC AURIGA",                    // current/main vessel name
 *   voyage: "615A",                          // voyage reference
 *   service: "IPANEMA",                      // service name (commercial)
 *   serviceCode: "412",                      // optional internal code
 *   etd: "2026-04-26T13:00:00",              // origin departure
 *   eta: "2026-06-22T20:00:00",              // destination arrival
 *   origin: "SHANGHAI",
 *   originCode: "CNSHA",
 *   destination: "SANTOS",
 *   destinationCode: "BRSSZ",
 *   status: "In transit" | "Loaded" | "Discharged" | "Delivered" | "Empty returned",
 *   isDirect: true | false,                  // direct or transhipment
 *   transitDays: 58,
 *
 *   // ===== DETAILS (shown when "more details" expanded) =====
 *   legs: [                                  // each leg = 1 vessel
 *     {
 *       vessel: "MSC AURIGA",
 *       voyage: "615A",
 *       service: "IPANEMA",
 *       serviceCode: "412",
 *       polCode: "CNSHA",
 *       polName: "SHANGHAI",
 *       polTerminal: "SIPG WAIGAOQIAO",
 *       podCode: "PAMIT",
 *       podName: "MANZANILLO",
 *       podTerminal: "MIT",
 *       etd: "2026-04-26T13:00:00",
 *       eta: "2026-06-01T11:00:00",
 *       imo: "9876543",
 *     }, ...
 *   ],
 *   portCalls: [                             // chronological port list
 *     { code:"CNSHA", name:"SHANGHAI", terminal:"...", arr:"", dep:"2026-04-26T13:00:00" },
 *     { code:"PAMIT", name:"MANZANILLO", terminal:"MIT", arr:"...", dep:"..." },
 *     { code:"BRSSZ", name:"SANTOS", terminal:"BTP", arr:"2026-06-22T20:00:00", dep:"" },
 *   ],
 *
 *   // ===== EVENTS (status timeline) =====
 *   events: [                                // historical milestones
 *     { date:"2026-04-25T08:00:00", description:"Empty container released to shipper", location:"SHANGHAI" },
 *     { date:"2026-04-26T13:00:00", description:"Loaded on board", location:"SHANGHAI", vessel:"MSC AURIGA" },
 *     { date:"2026-06-01T11:00:00", description:"Discharged at transhipment", location:"MANZANILLO" },
 *     { date:"2026-06-08T19:00:00", description:"Loaded on second vessel", location:"MANZANILLO", vessel:"MSC RHEA" },
 *   ],
 *
 *   // ===== CONTAINER-LEVEL FIELDS (only when type=cntr) =====
 *   container: {
 *     number: "MSCU1234567",
 *     size: "40HC",
 *     type: "DRY",
 *     sealNumber: "SEAL12345",
 *     weight: 18500,                         // kg
 *   },
 *
 *   // ===== METADATA =====
 *   raw: {...},                              // raw API response (for debugging)
 *   fetchedAt: "2026-04-30T14:30:00.000Z",
 * }
 *
 * Failure response:
 * { ok: false, error: "human readable message", carrier: "MSC" }
 */

// ============================================================================
// SHARED HELPERS
// ============================================================================

/**
 * Returns a standard "not implemented" response. Used until each carrier's
 * real API is wired up.
 */
function notImplemented(carrier, refType) {
  return {
    ok: false,
    error: `${carrier} ${refType} tracking not yet configured`,
    carrier,
    notConfigured: true, // flag so frontend can show distinct message
  };
}

/**
 * Wraps a tracker function with timeout + uniform error handling.
 * Use this when calling trackers in parallel so a hung API doesn't block
 * the entire response.
 */
async function withTimeout(promise, ms = 12000, carrier = "?") {
  return Promise.race([
    promise.catch(e => ({ ok: false, error: e.message || String(e), carrier })),
    new Promise(resolve => setTimeout(() => resolve({ ok: false, error: "timeout", carrier }), ms)),
  ]);
}

// ============================================================================
// MSC
// ============================================================================
// MSC tracking endpoint is the same for all 3 reference types — only
// `trackingMode` changes:
//   - booking → "1"
//   - MBL     → "0"
//   - cntr    → "0"
//
// Response shape (top level):
//   { IsSuccess: true, Data: { TrackingType, TrackingNumber, BillOfLadings: [...] } }
// Each BL has 1+ ContainersInfo entries; each container has Events with date,
// location, description, vessel, terminal, etc.
//
// Strategy:
//   - If MBL/booking returns multiple containers, we report ONE card per BL
//     (since header info is shared). Per-container details go in `legs` /
//     `events` arrays. If a CNTR-mode lookup returns the BL containing it,
//     we narrow to just that container's events.
//   - For multi-container BL, we use the FIRST container's events as the
//     timeline (they're nearly identical anyway), and list all container
//     numbers in a `containerNumbers` array surfaced in details.
//
// MSC dates come as DD/MM/YYYY or "DD/MM/YYYY HH:mm". We parse to ISO so the
// frontend's parseAnyDate handles them, but we ALSO keep the raw string in
// portCalls/events as a fallback.

const MSC_TRACK_URL = "https://www.msc.com/api/feature/tools/TrackingInfo";
const MSC_TRACK_REFERER = "https://www.msc.com/en/track-a-shipment";

/** Parse "DD/MM/YYYY" or "DD/MM/YYYY HH:mm" → ISO string. Returns "" on failure. */
function mscParseDate(s) {
  if (!s) return "";
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return s;
  const [, d, mo, y, h, mi] = m;
  const dd = d.padStart(2, "0");
  const mm = mo.padStart(2, "0");
  const hh = (h || "00").padStart(2, "0");
  const mim = (mi || "00").padStart(2, "0");
  return `${y}-${mm}-${dd}T${hh}:${mim}:00`;
}

/** Calls the MSC tracking endpoint with the right mode for a reference. */
async function mscFetchTracking(reference, trackingMode) {
  const { httpPostJson, getMscSession, clearMscSession, UA } = require("./helpers");
  let cookies = await getMscSession();
  const doRequest = async (cks) => httpPostJson(MSC_TRACK_URL, {
    trackingNumber: String(reference),
    trackingMode: String(trackingMode),
  }, {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://www.msc.com",
    "Referer": MSC_TRACK_REFERER,
    "x-requested-with": "XMLHttpRequest",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Ch-Ua": '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Cookie": cks,
  });
  let result = await doRequest(cookies);
  // If we got rejected (403/401), refresh cookie once and retry. Saves us
  // from manually clearing on every cookie expiry.
  if (result.status === 401 || result.status === 403) {
    clearMscSession();
    cookies = await getMscSession();
    result = await doRequest(cookies);
  }
  if (result.status !== 200) {
    return { error: `MSC HTTP ${result.status}` };
  }
  let parsed;
  try { parsed = JSON.parse(result.data); }
  catch (e) { return { error: "MSC returned non-JSON" }; }
  if (!parsed || !parsed.IsSuccess) {
    return { error: parsed && parsed.Data ? String(parsed.Data) : "MSC reported failure" };
  }
  return { data: parsed.Data };
}

/**
 * Normalize a single container's events into a tracking result. Used by
 * mscNormalizeResponse below, which loops over all containers in the BL.
 */
function mscNormalizeContainer(bl, info, container, reference, refType) {
  const events = (container.Events || []).slice().sort((a, b) => (a.Order || 0) - (b.Order || 0));

  // === Find vessel info ===
  let mainVessel = "", mainVoyage = "", mainImo = "";
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.Detail && ev.Detail[0] && ev.Vessel && ev.Vessel.IMO) {
      mainVessel = ev.Detail[0];
      mainVoyage = ev.Detail[1] || "";
      mainImo = ev.Vessel.IMO;
      break;
    }
  }

  // === ETD / ETA ===
  const loadEvent = events.find(e => /Loaded on Vessel/i.test(e.Description) || /Export Loaded/i.test(e.Description));
  const arrivalEvent = events.find(e => /Estimated Time of Arrival/i.test(e.Description) || /Discharged at PO[DA]/i.test(e.Description));
  const etd = loadEvent ? mscParseDate(loadEvent.Date) : "";
  const eta = arrivalEvent ? mscParseDate(arrivalEvent.Date) : mscParseDate(info.FinalPodEtaDate || container.PodEtaDate || "");

  // === Status ===
  const latestEvent = events[events.length - 1];
  let status = "In transit";
  if (bl.Delivered || container.Delivered) status = "Delivered";
  else if (container.LatestMove) {
    const latestDesc = latestEvent && latestEvent.Description || "";
    if (/Empty.*returned/i.test(latestDesc)) status = "Empty returned";
    else if (/Discharged.*PO[DA]/i.test(latestDesc)) status = "Discharged";
    else if (/Loaded/i.test(latestDesc)) status = "Loaded";
    else if (/Estimated/i.test(latestDesc)) status = "In transit";
  }

  const transhipments = info.Transshipments || [];
  const isDirect = transhipments.length === 0;

  // === Legs (vessel transitions) ===
  const eventsAsc = events.slice().sort((a, b) => (a.Order || 0) - (b.Order || 0));
  const legs = [];
  let currentLeg = null;
  for (const ev of eventsAsc) {
    const vessel = ev.Detail && ev.Detail[0];
    const voyage = ev.Detail && ev.Detail[1];
    if (!vessel || /^(EMPTY|LADEN)$/i.test(vessel)) continue;
    const isLoadEv = /Loaded on Vessel/i.test(ev.Description) || /Export Loaded/i.test(ev.Description) || /Transshipment Loaded/i.test(ev.Description);
    const isDischargeEv = /Discharged/i.test(ev.Description) || /Estimated Time of Arrival/i.test(ev.Description);
    if (isLoadEv) {
      currentLeg = {
        vessel, voyage,
        polCode: ev.UnLocationCode || "",
        polName: (ev.Location || "").split(",")[0].trim(),
        polTerminal: (ev.EquipmentHandling && ev.EquipmentHandling.Name) || "",
        etd: mscParseDate(ev.Date),
        imo: ev.Vessel && ev.Vessel.IMO || "",
      };
      legs.push(currentLeg);
    } else if (isDischargeEv && currentLeg && currentLeg.vessel === vessel) {
      currentLeg.podCode = ev.UnLocationCode || "";
      currentLeg.podName = (ev.Location || "").split(",")[0].trim();
      currentLeg.podTerminal = (ev.EquipmentHandling && ev.EquipmentHandling.Name) || "";
      currentLeg.eta = mscParseDate(ev.Date);
    }
  }

  // === Port calls ===
  const portCalls = [];
  const seen = new Map();
  const pushPort = (code, name, terminal, arr, dep) => {
    if (!code && !name) return;
    const key = code || name;
    const idx = seen.get(key);
    if (idx == null) {
      portCalls.push({ code: code || "", name: name || code || "", terminal: terminal || "", arr: arr || "", dep: dep || "" });
      seen.set(key, portCalls.length - 1);
    } else {
      const e = portCalls[idx];
      if (arr && !e.arr) e.arr = arr;
      if (dep && !e.dep) e.dep = dep;
      if (terminal && !e.terminal) e.terminal = terminal;
    }
  };
  for (const ev of eventsAsc) {
    const code = ev.UnLocationCode || "";
    const name = (ev.Location || "").split(",")[0].trim();
    const terminal = (ev.EquipmentHandling && ev.EquipmentHandling.Name) || "";
    const isLoadEv = /Loaded on Vessel/i.test(ev.Description) || /Export Loaded/i.test(ev.Description) || /Transshipment Loaded/i.test(ev.Description);
    const isDischargeEv = /Discharged/i.test(ev.Description) || /Estimated Time of Arrival/i.test(ev.Description);
    if (isLoadEv) pushPort(code, name, terminal, "", mscParseDate(ev.Date));
    else if (isDischargeEv) pushPort(code, name, terminal, mscParseDate(ev.Date), "");
    if (Array.isArray(ev.IntermediaryPortCalls)) {
      for (const ipc of ev.IntermediaryPortCalls) {
        pushPort("", ipc.LocationName || "", "", mscParseDate(ipc.Eta), mscParseDate(ipc.Etd));
      }
    }
  }

  // === Events list (preserved with full detail for the timeline UI) ===
  // We keep the raw fields so the UI can render an MSC-style table:
  // Date | Location | Description | Vessel/Voyage | Terminal
  const evList = eventsAsc.slice().reverse().map(ev => {
    const detail = Array.isArray(ev.Detail) ? ev.Detail : [];
    const vessel = detail[0] && !/^(EMPTY|LADEN)$/i.test(detail[0]) ? detail[0] : "";
    const voyage = vessel ? (detail[1] || "") : "";
    const cargoState = !vessel && detail[0] ? detail[0] : ""; // EMPTY / LADEN
    return {
      date: mscParseDate(ev.Date),
      dateRaw: ev.Date || "",
      description: ev.Description || "",
      location: ev.Location || "",
      locationCode: ev.UnLocationCode || "",
      vessel,
      voyage,
      cargoState,
      terminal: (ev.EquipmentHandling && ev.EquipmentHandling.Name) || "",
    };
  });

  // === Container info ===
  const containerInfo = {
    number: container.ContainerNumber || "",
    type: container.ContainerType || "",
  };

  // === Transit days ===
  let transitDays = null;
  if (etd && eta) {
    const t1 = new Date(etd), t2 = new Date(eta);
    if (!isNaN(t1) && !isNaN(t2)) transitDays = Math.round((t2 - t1) / 86400000);
  }

  const splitLoc = s => {
    const parts = String(s || "").split(",").map(x => x.trim());
    return { name: parts[0] || "", country: parts[1] || "" };
  };
  const polObj = splitLoc(info.PortOfLoad || info.ShippedFrom);
  const podObj = splitLoc(info.PortOfDischarge || info.ShippedTo);
  const firstLeg = legs[0];
  const lastLeg = legs[legs.length - 1];
  const originCode = (firstLeg && firstLeg.polCode) || "";
  const destinationCode = (lastLeg && lastLeg.podCode) || "";

  return {
    ok: true,
    carrier: "MSC",
    reference,
    referenceType: refType,

    vessel: mainVessel || "—",
    voyage: mainVoyage || "",
    service: "",
    serviceCode: "",
    etd: etd || "",
    eta: eta || "",
    origin: polObj.name,
    originCode,
    destination: podObj.name,
    destinationCode,
    status,
    isDirect,
    transitDays,

    legs,
    portCalls,
    events: evList,
    container: containerInfo,
    blNumber: bl.BillOfLadingNumber || "",
    latestMove: container.LatestMove || "",
    podEtaDate: mscParseDate(container.PodEtaDate || info.FinalPodEtaDate || ""),

    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Build standard response from MSC tracking JSON.
 * Returns ARRAY of results — one per container — when the BL has multiple
 * containers (typical for booking/MBL lookups). Returns a single result for
 * cntr lookups (filtered to the matching container).
 */
function mscNormalizeResponse(data, reference, refType, containerFilter) {
  if (!data || !Array.isArray(data.BillOfLadings) || data.BillOfLadings.length === 0) {
    return { ok: false, error: "MSC: no BL data", carrier: "MSC" };
  }
  const bl = data.BillOfLadings[0];
  const info = bl.GeneralTrackingInfo || {};

  let containers = bl.ContainersInfo || [];
  if (refType === "cntr" && containerFilter) {
    const match = containers.find(c =>
      String(c.ContainerNumber || "").toUpperCase() === String(containerFilter).toUpperCase()
    );
    if (match) containers = [match];
  }
  if (containers.length === 0) {
    return { ok: false, error: "MSC: no container data", carrier: "MSC" };
  }

  // For booking/MBL with multiple containers → return one card per container
  // For cntr lookup or single-container BL → return one card
  const results = containers.map(c => mscNormalizeContainer(bl, info, c, reference, refType));
  return results.length === 1 ? results[0] : results;
}

async function mscBookingTrack(reference) {
  const { data, error } = await mscFetchTracking(reference, "1");
  if (error) return { ok: false, error, carrier: "MSC" };
  return mscNormalizeResponse(data, reference, "booking");
}
async function mscMblTrack(reference) {
  const { data, error } = await mscFetchTracking(reference, "0");
  if (error) return { ok: false, error, carrier: "MSC" };
  return mscNormalizeResponse(data, reference, "mbl");
}
async function mscCntrTrack(reference) {
  const { data, error } = await mscFetchTracking(reference, "0");
  if (error) return { ok: false, error, carrier: "MSC" };
  return mscNormalizeResponse(data, reference, "cntr", reference);
}

// ============================================================================
// CMA CGM
// ============================================================================
// Self-contained tracking impl. Reads CMA_COOKIES env var directly on each
// call (server.js owns the canonical value but this file does not depend on
// it being shared via helpers — keeps the change isolated to trackers.js).
//
// Endpoint: POST /ebusiness/tracking/search with form-urlencoded body.
// Response is a full HTML page with `var model = [...]` JS embedded.
// SearchBy = "Booking" | "BL" | "Container".
const https = require("https");
const zlib = require("zlib");

const CMA_TRACK_URL = "https://www.cma-cgm.com/ebusiness/tracking/search";
const CMA_TRACK_REFERER = "https://www.cma-cgm.com/ebusiness/tracking";
const CMA_TRACK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

function _cmaSanitizeCookies(s) {
  return String(s || "")
    .replace(/[\r\n\t]+/g, "")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .trim();
}

function _cmaPostForm(formData, cookies) {
  return new Promise((resolve, reject) => {
    const body = Object.entries(formData)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const u = new URL(CMA_TRACK_URL);
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
        "Referer": CMA_TRACK_REFERER,
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
        "User-Agent": CMA_TRACK_UA,
        "Sec-Ch-Device-Memory": "8",
        "Sec-Ch-Ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Microsoft Edge";v="146"',
        "Sec-Ch-Ua-Arch": '"x86"',
        "Sec-Ch-Ua-Full-Version-List": '"Chromium";v="146.0.7680.179", "Not-A.Brand";v="24.0.0.0", "Microsoft Edge";v="146.0.3856.109"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Model": '""',
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Priority": "u=0, i",
        "Cookie": cookies,
      },
      timeout: 30000,
    }, (res) => {
      const status = res.statusCode;
      const encoding = res.headers["content-encoding"] || "";
      let stream = res;
      if (encoding === "gzip" || encoding === "x-gzip") stream = res.pipe(zlib.createGunzip());
      else if (encoding === "br") stream = res.pipe(zlib.createBrotliDecompress());
      else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on("data", c => chunks.push(c));
      stream.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
      stream.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("CMA POST timeout")); });
    req.write(body);
    req.end();
  });
}

function _cmaCleanDate(s) {
  if (!s || typeof s !== "string") return "";
  if (s.startsWith("0001-")) return ""; // .NET DateTime.MinValue
  return s;
}

function _cmaStatusLabel(status, code) {
  const c = String(code || "").toUpperCase();
  switch (c) {
    case "MOS": return "Empty to shipper";
    case "XRX": return "Ready to load";
    case "XOF": return "Loaded";
    case "AVD": return "Vessel departed";
    case "AVA": return "Vessel arrived";
    case "TDF": return "Discharged (transhipment)";
    case "TOF": return "Loaded (transhipment)";
    case "IDF": return "Discharged";
    case "IFC": return "Delivered";
    case "MEA": return "Empty returned";
    case "PVD": return "Planned departure";
    case "PVA": return "Planned arrival";
  }
  const s = String(status || "");
  if (/EmptyInDepot/i.test(s)) return "Empty returned";
  if (/ContainerToConsignee/i.test(s)) return "Delivered";
  if (/Discharged/i.test(s)) return "Discharged";
  if (/Loadedonboard/i.test(s)) return "Loaded";
  if (/ActualVesselDeparture/i.test(s)) return "Vessel departed";
  if (/ActualVesselArrival/i.test(s)) return "Vessel arrived";
  if (/EmptyDeliveredToShipper/i.test(s)) return "Empty to shipper";
  if (/Readytobeloaded/i.test(s)) return "Ready to load";
  return "In transit";
}

function _cmaExtractModel(html) {
  const m = html.match(/var\s+model\s*=\s*(\[[\s\S]*?\])\s*;\s*var\s+searchViewModel/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

function _cmaNormalizeContainer(entry, reference, refType) {
  const details = entry.ContainerMoveDetails || {};
  const routing = details.routingInformation || {};
  const refs = details.references || {};
  const pastMoves = Array.isArray(details.pastMoves) ? details.pastMoves : [];
  const currentMoves = Array.isArray(details.currentMoves) ? details.currentMoves : [];
  const futureMoves = Array.isArray(details.futureMoves) ? details.futureMoves : [];
  const allMoves = [...pastMoves, ...currentMoves, ...futureMoves];
  const pol = routing.portOfLoading || {};
  const pod = routing.portOfDischarge || {};

  // Build legs by pairing load (XOF/TOF/PVD) → discharge (IDF/TDF/AVA/PVA)
  const legs = [];
  let openLeg = null;
  for (const move of allMoves) {
    const code = String(move.containerStatusDescription || "").toUpperCase();
    const isLoad = code === "XOF" || code === "TOF" || code === "PVD";
    const isDischarge = code === "IDF" || code === "TDF" || code === "AVA" || code === "PVA";
    if (isLoad) {
      if (openLeg) legs.push(openLeg);
      openLeg = {
        vessel: move.vesselName || "",
        voyage: move.voyageReference || "",
        service: "", serviceCode: "",
        polCode: (move.location && move.location.code) || "",
        polName: (move.location && move.location.name) || "",
        polTerminal: move.locationTerminal || "",
        podCode: "", podName: "", podTerminal: "",
        etd: _cmaCleanDate(move.containerStatusDate),
        eta: "",
        imo: move.vesselId || "",
      };
    } else if (isDischarge && openLeg && openLeg.vessel === move.vesselName) {
      openLeg.podCode = (move.location && move.location.code) || "";
      openLeg.podName = (move.location && move.location.name) || "";
      openLeg.podTerminal = move.locationTerminal || "";
      openLeg.eta = _cmaCleanDate(move.containerStatusDate);
      legs.push(openLeg);
      openLeg = null;
    }
  }
  if (openLeg) legs.push(openLeg);

  // Port calls
  const portCalls = [];
  const seen = new Map();
  const pushPort = (code, name, terminal, arr, dep) => {
    if (!code && !name) return;
    const key = code || name;
    const idx = seen.get(key);
    if (idx == null) {
      portCalls.push({ code: code || "", name: name || code || "", terminal: terminal || "", arr: arr || "", dep: dep || "" });
      seen.set(key, portCalls.length - 1);
    } else {
      const e = portCalls[idx];
      if (arr && !e.arr) e.arr = arr;
      if (dep && !e.dep) e.dep = dep;
      if (terminal && !e.terminal) e.terminal = terminal;
    }
  };
  for (const move of allMoves) {
    const code = String(move.containerStatusDescription || "").toUpperCase();
    const loc = move.location || {};
    const date = _cmaCleanDate(move.containerStatusDate);
    if (code === "XOF" || code === "TOF" || code === "AVD" || code === "PVD") {
      pushPort(loc.code, loc.name, move.locationTerminal, "", date);
    } else if (code === "AVA" || code === "IDF" || code === "TDF" || code === "PVA") {
      pushPort(loc.code, loc.name, move.locationTerminal, date, "");
    } else {
      pushPort(loc.code, loc.name, move.locationTerminal, "", "");
    }
  }

  // Events list (newest-first)
  const evList = allMoves.slice().reverse().map(move => ({
    date: _cmaCleanDate(move.containerStatusDate),
    dateRaw: move.containerStatusDate || "",
    description: _cmaStatusLabel(move.containerStatus, move.containerStatusDescription),
    location: (move.location && move.location.name) || "",
    locationCode: (move.location && move.location.code) || "",
    vessel: move.vesselName || "",
    voyage: move.voyageReference || "",
    cargoState: "",
    terminal: move.locationTerminal || "",
  }));

  const latest = currentMoves[currentMoves.length - 1] || pastMoves[pastMoves.length - 1] || {};
  const status = _cmaStatusLabel(details.containerStatus, latest.containerStatusDescription);
  const mainVessel = latest.vesselName || (legs[legs.length - 1] && legs[legs.length - 1].vessel) || "";
  const mainVoyage = latest.voyageReference || (legs[legs.length - 1] && legs[legs.length - 1].voyage) || "";
  const etd = _cmaCleanDate(pol.date);
  const eta = _cmaCleanDate(entry.EstimatedTimeOfArrival || pod.date);
  const isDirect = legs.length <= 1;
  let transitDays = null;
  if (etd && eta) {
    const t1 = new Date(etd), t2 = new Date(eta);
    if (!isNaN(t1) && !isNaN(t2)) transitDays = Math.round((t2 - t1) / 86400000);
  }
  const stripCountry = s => String(s || "").replace(/\s*\([A-Z]{2}\)\s*$/, "").trim();

  return {
    ok: true, carrier: "CMA", reference, referenceType: refType,
    vessel: mainVessel || "—",
    voyage: mainVoyage || "",
    service: "", serviceCode: "",
    etd: etd || "", eta: eta || "",
    origin: stripCountry(pol.name), originCode: pol.code || "",
    destination: stripCountry(pod.name), destinationCode: pod.code || "",
    status, isDirect, transitDays,
    legs, portCalls, events: evList,
    container: {
      number: entry.ContainerReference || "",
      size: entry.LaraContainerSize || entry.SizeAndType || "",
      type: entry.Type || "",
    },
    blNumber: refs.blReference || "",
    bookingNumber: refs.shipmentReference || "",
    latestMove: _cmaStatusLabel(latest.containerStatus, latest.containerStatusDescription),
    podEtaDate: _cmaCleanDate(entry.EstimatedTimeOfArrival),
    fetchedAt: new Date().toISOString(),
  };
}

async function _cmaTrack(reference, searchBy, refType) {
  const cookies = _cmaSanitizeCookies(process.env.CMA_COOKIES || "");
  if (!cookies) return { ok: false, error: "CMA_COOKIES not configured", carrier: "CMA" };
  let result;
  try {
    result = await _cmaPostForm({
      "SearchViewModel.SearchBy": searchBy,
      "SearchViewModel.Reference": String(reference),
      "SearchViewModel.FromHome": "false",
    }, cookies);
  } catch (e) {
    return { ok: false, error: `CMA: ${e.message}`, carrier: "CMA" };
  }
  if (result.status !== 200) return { ok: false, error: `CMA HTTP ${result.status}`, carrier: "CMA" };
  if (/datadome|captcha|access denied/i.test(result.body.substring(0, 2000))) {
    return { ok: false, error: "CMA: DataDome blocked — refresh CMA_COOKIES", carrier: "CMA" };
  }
  const model = _cmaExtractModel(result.body);
  if (!model || model.length === 0) {
    return { ok: false, error: "CMA: no match", carrier: "CMA" };
  }
  let entries = model;
  if (refType === "cntr") {
    const match = model.find(e => String(e.ContainerReference || "").toUpperCase() === String(reference).toUpperCase());
    if (match) entries = [match];
  }
  const cards = entries.map(e => _cmaNormalizeContainer(e, reference, refType));
  return cards.length === 1 ? cards[0] : cards;
}

async function cmaBookingTrack(reference) { return _cmaTrack(reference, "Booking", "booking"); }
async function cmaMblTrack(reference)     { return _cmaTrack(reference, "BL", "mbl"); }
async function cmaCntrTrack(reference)    { return _cmaTrack(reference, "Container", "cntr"); }

// ============================================================================
// MAERSK
// ============================================================================
// Maersk tracking uses the same `api.maersk.com` host as schedules but a
// different consumer-key (each Maersk product has its own public key). The
// endpoint is GET /synergy/tracking/{reference}?operator=MAEU and returns
// JSON. Booking, MBL and container all hit the same endpoint — Maersk infers
// the type from the reference format.
//
// Akamai Bot Manager protects the API. Telemetry tokens are PAGE-SPECIFIC:
// the one generated on /schedules works only for the schedules endpoint, and
// the one generated on /tracking works only for the tracking endpoint. So we
// need a separate env var for each. Set MAERSK_TRACK_BM_TELEMETRY to the
// telemetry value captured from a request made on www.maersk.com/tracking.
// Falls back to MAERSK_BM_TELEMETRY (schedule one) if not set, but expect
// 403 in that case — they don't cross-validate.
//
// Response shape (per container):
//   { container_num, container_size, container_type, iso_code, operator,
//     locations: [
//       { terminal, city, country, country_code, location_code,
//         events: [
//           { activity, vessel_name?, voyage_num?, transport_mode,
//             event_time, event_time_type ("ACTUAL"|"ESTIMATED"),
//             stempty (bool — empty container), actfor ("EXP"|"DEL") }
//         ]
//       }
//     ],
//     eta_final_delivery, status }
//
// Activity codes seen: GATE-OUT, GATE-IN, LOAD, DISCHARG, CONTAINER ARRIVAL,
// CONTAINER DEPARTURE, CONTAINER RETURN. transport_mode: MVS (mainline vessel),
// FEF (feeder/barge), TRK (truck).

const MAERSK_TRACK_URL_BASE = "https://api.maersk.com/synergy/tracking/";
const MAERSK_TRACK_PAGE = "https://www.maersk.com/tracking";
const MAERSK_TRACK_CONSUMER_KEY = "UtMm6JCDcGTnMGErNGvS2B98kt1Wl25H"; // public app key
const MAERSK_TRACK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

// Cache for the Akamai cookies (_abck, bm_sv, bm_sz, ak_bmsc) collected from
// the public tracking page. They're what the API expects in the Cookie header
// alongside the akamai-bm-telemetry value. TTL = 25 min (well under the
// usual 30-min lifetime of these cookies).
const MAERSK_COOKIE_TTL = 25 * 60 * 1000;
let _maerskCookies = "";
let _maerskCookiesTime = 0;

/** GET maersk.com/tracking just to harvest the Akamai bot manager cookies. */
function _maerskHarvestCookies() {
  return new Promise((resolve) => {
    const u = new URL(MAERSK_TRACK_PAGE);
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname,
      method: "GET",
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        "Sec-Ch-Ua": '"Brave";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Sec-Gpc": "1",
        "Upgrade-Insecure-Requests": "1",
        "User-Agent": MAERSK_TRACK_UA,
      },
      timeout: 15000,
    }, (res) => {
      const setCookies = res.headers["set-cookie"] || [];
      const cookieStr = setCookies.map(c => c.split(";")[0]).join("; ");
      // Drain body to free the socket (don't need the HTML).
      res.on("data", () => {});
      res.on("end", () => resolve(cookieStr));
      res.on("error", () => resolve(""));
    });
    req.on("error", () => resolve(""));
    req.on("timeout", () => { req.destroy(); resolve(""); });
    req.end();
  });
}

async function _maerskGetCookies(forceRefresh) {
  if (!forceRefresh && _maerskCookies && Date.now() - _maerskCookiesTime < MAERSK_COOKIE_TTL) {
    return _maerskCookies;
  }
  const cks = await _maerskHarvestCookies();
  if (cks) {
    _maerskCookies = cks;
    _maerskCookiesTime = Date.now();
  }
  return cks;
}

function _maerskGet(reference, cookies) {
  return new Promise((resolve, reject) => {
    const url = `${MAERSK_TRACK_URL_BASE}${encodeURIComponent(reference)}?operator=MAEU`;
    const u = new URL(url);
    const headers = {
      "Accept": "application/json",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "pt-BR,pt;q=0.9",
      "Api-Version": "v2",
      "Consumer-Key": MAERSK_TRACK_CONSUMER_KEY,
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
      "User-Agent": MAERSK_TRACK_UA,
    };
    const tel = String(process.env.MAERSK_TRACK_BM_TELEMETRY || process.env.MAERSK_BM_TELEMETRY || "").trim();
    if (tel) headers["Akamai-Bm-Telemetry"] = tel;
    if (cookies) headers["Cookie"] = cookies;

    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: "GET",
      headers,
      timeout: 30000,
    }, (res) => {
      const encoding = res.headers["content-encoding"] || "";
      let stream = res;
      if (encoding === "gzip" || encoding === "x-gzip") stream = res.pipe(zlib.createGunzip());
      else if (encoding === "br") stream = res.pipe(zlib.createBrotliDecompress());
      else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on("data", c => chunks.push(c));
      stream.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      stream.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Maersk GET timeout")); });
    req.end();
  });
}

/** Maersk activity → human readable description. */
function _maerskActivityLabel(activity, transportMode, stempty, actfor) {
  const a = String(activity || "").toUpperCase();
  switch (a) {
    case "GATE-OUT":
      if (stempty && actfor === "EXP") return "Empty released to shipper";
      if (stempty && actfor === "DEL") return "Empty returned";
      if (actfor === "DEL") return "Delivered (gate out)";
      return "Gate out";
    case "GATE-IN":
      if (actfor === "EXP") return "Gate in at terminal";
      return "Gate in";
    case "LOAD":
      if (transportMode === "FEF") return "Loaded on barge";
      return "Loaded on vessel";
    case "DISCHARG":
    case "DISCHARGE":
      if (transportMode === "FEF") return "Discharged from barge";
      return "Discharged";
    case "CONTAINER ARRIVAL": return "Vessel arrived";
    case "CONTAINER DEPARTURE": return "Vessel departed";
    case "CONTAINER RETURN": return "Empty returned";
    case "TRANSHIPMENT": return "Transhipment";
  }
  return a || "Event";
}

/** Strip country suffix like "(CN)" and clean up location names to title case. */
function _maerskCleanLocName(s) {
  if (!s) return "";
  // Maersk gives names in upper-case sometimes, mixed case other times.
  // Normalize to upper case (matches what MSC/CMA show).
  return String(s).replace(/\s*\([A-Z]{2}\)\s*$/, "").trim().toUpperCase();
}

/** Build one tracking card from a single Maersk container entry. */
function _maerskNormalizeContainer(cnt, header, reference, refType) {
  const locations = Array.isArray(cnt.locations) ? cnt.locations : [];

  // Flatten all events with their location attached. Maersk events come
  // already in chronological order per location, and locations are listed
  // in route order, so the flat array is also chronological.
  const flatEvents = [];
  for (const loc of locations) {
    const evs = Array.isArray(loc.events) ? loc.events : [];
    for (const e of evs) {
      flatEvents.push({
        ...e,
        _locName: _maerskCleanLocName(loc.terminal || loc.city),
        _locCity: _maerskCleanLocName(loc.city),
        _locCode: loc.location_code || "",
        _terminal: loc.terminal || "",
      });
    }
  }
  // Sort by event_time as a safety net (in case API returns out-of-order).
  flatEvents.sort((a, b) => String(a.event_time).localeCompare(String(b.event_time)));

  // === Build legs from LOAD → DISCHARG (or CONTAINER DEPARTURE → ARRIVAL) ===
  // We pair sequential vessel pairs, ignoring barge/feeder (FEF) for the leg
  // count — but still include them as port calls. Mainline (MVS) defines legs.
  const legs = [];
  let openLeg = null;
  for (const ev of flatEvents) {
    const act = String(ev.activity || "").toUpperCase();
    const mode = String(ev.transport_mode || "").toUpperCase();
    if (act === "LOAD" && mode === "MVS") {
      if (openLeg) legs.push(openLeg);
      openLeg = {
        vessel: ev.vessel_name || "",
        voyage: ev.voyage_num || "",
        service: "",
        serviceCode: "",
        polCode: ev._locCode || "",
        polName: ev._locCity || ev._locName || "",
        polTerminal: ev._terminal || "",
        podCode: "",
        podName: "",
        podTerminal: "",
        etd: ev.event_time || "",
        eta: "",
        imo: ev.vessel_num || "",
      };
    } else if ((act === "DISCHARG" || act === "DISCHARGE") && mode === "MVS" && openLeg && openLeg.vessel === ev.vessel_name) {
      openLeg.podCode = ev._locCode || "";
      openLeg.podName = ev._locCity || ev._locName || "";
      openLeg.podTerminal = ev._terminal || "";
      openLeg.eta = ev.event_time || "";
      legs.push(openLeg);
      openLeg = null;
    }
  }
  if (openLeg) legs.push(openLeg);

  // === Port calls — one per location, summarizing arrival/departure dates ===
  const portCalls = [];
  for (const loc of locations) {
    const evs = Array.isArray(loc.events) ? loc.events : [];
    let arr = "", dep = "";
    for (const e of evs) {
      const act = String(e.activity || "").toUpperCase();
      if (act === "CONTAINER ARRIVAL" || act === "DISCHARG" || act === "DISCHARGE") {
        if (!arr) arr = e.event_time || "";
      }
      if (act === "CONTAINER DEPARTURE" || act === "LOAD") {
        if (!dep) dep = e.event_time || "";
      }
    }
    portCalls.push({
      code: loc.location_code || "",
      name: _maerskCleanLocName(loc.city) || _maerskCleanLocName(loc.terminal),
      terminal: loc.terminal || "",
      arr,
      dep,
    });
  }

  // === Events list (newest-first for the timeline UI) ===
  const evList = flatEvents.slice().reverse().map(e => ({
    date: e.event_time || "",
    dateRaw: e.event_time || "",
    description: _maerskActivityLabel(e.activity, e.transport_mode, e.stempty, e.actfor)
                + (e.event_time_type === "ESTIMATED" ? " (estimated)" : ""),
    location: e._locName || e._locCity || "",
    locationCode: e._locCode || "",
    vessel: e.vessel_name || "",
    voyage: e.voyage_num || "",
    cargoState: e.stempty ? "EMPTY" : "",
    terminal: e._terminal || "",
  }));

  // === Header info ===
  const origin = header.origin || {};
  const destination = header.destination || {};

  // Latest event determines status display.
  const latestEv = flatEvents[flatEvents.length - 1] || {};
  const latestLabel = _maerskActivityLabel(latestEv.activity, latestEv.transport_mode, latestEv.stempty, latestEv.actfor);
  const status = String(header.status || "").toLowerCase() === "complete" ? "Delivered" : (latestLabel || "In transit");

  // ETD = first MVS load event; ETA = eta_final_delivery or last event.
  let etd = "";
  for (const e of flatEvents) {
    if (String(e.activity).toUpperCase() === "LOAD" && String(e.transport_mode).toUpperCase() === "MVS") {
      etd = e.event_time || "";
      break;
    }
  }
  // Fallback: first event of any kind (includes barge gate-out).
  if (!etd && flatEvents.length > 0) etd = flatEvents[0].event_time || "";

  const eta = cnt.eta_final_delivery || (flatEvents[flatEvents.length - 1] && flatEvents[flatEvents.length - 1].event_time) || "";

  // Vessel/voyage shown in the card header = main mainline leg.
  const mainLeg = legs[legs.length - 1] || legs[0] || {};
  const mainVessel = mainLeg.vessel || latestEv.vessel_name || "";
  const mainVoyage = mainLeg.voyage || latestEv.voyage_num || "";

  const isDirect = legs.length <= 1;

  let transitDays = null;
  if (etd && eta) {
    const t1 = new Date(etd), t2 = new Date(eta);
    if (!isNaN(t1) && !isNaN(t2)) transitDays = Math.round((t2 - t1) / 86400000);
  }

  return {
    ok: true,
    carrier: "MAERSK",
    reference,
    referenceType: refType,

    vessel: mainVessel || "—",
    voyage: mainVoyage || "",
    service: "",
    serviceCode: "",
    etd: etd || "",
    eta: eta || "",
    origin: _maerskCleanLocName(origin.city) || _maerskCleanLocName(origin.terminal),
    originCode: origin.location_code || "",
    destination: _maerskCleanLocName(destination.city) || _maerskCleanLocName(destination.terminal),
    destinationCode: destination.location_code || "",
    status,
    isDirect,
    transitDays,

    legs,
    portCalls,
    events: evList,
    container: {
      number: cnt.container_num || "",
      size: cnt.container_size || "",
      type: cnt.container_type || "",
    },
    blNumber: "", // Maersk doesn't expose BL in tracking response
    bookingNumber: cnt.shipment_num || header.tpdoc_num || "",
    latestMove: latestLabel,
    podEtaDate: cnt.eta_final_delivery || "",

    fetchedAt: new Date().toISOString(),
  };
}

async function _maerskTrack(reference, refType) {
  // Step 1: harvest Akamai bot manager cookies from the public tracking page.
  // Akamai requires both cookies + telemetry to authorize API requests.
  let cookies = await _maerskGetCookies(false);

  // Step 2: call API with cookies + telemetry.
  let result;
  try {
    result = await _maerskGet(reference, cookies);
  } catch (e) {
    return { ok: false, error: `MAERSK: ${e.message}`, carrier: "MAERSK" };
  }

  // Retry once with fresh cookies if Akamai rejected us — the cached cookies
  // may have expired since we last harvested.
  if (result.status === 403) {
    cookies = await _maerskGetCookies(true);
    if (cookies) {
      try {
        result = await _maerskGet(reference, cookies);
      } catch (e) {
        return { ok: false, error: `MAERSK: ${e.message}`, carrier: "MAERSK" };
      }
    }
  }

  if (result.status === 404) {
    return { ok: false, error: "MAERSK: no match", carrier: "MAERSK" };
  }
  if (result.status === 403) {
    const preview = (result.body || "").substring(0, 200).replace(/\s+/g, " ");
    return { ok: false, error: `MAERSK HTTP 403 — preview: ${preview}`, carrier: "MAERSK" };
  }
  if (result.status !== 200) {
    const preview = (result.body || "").substring(0, 200).replace(/\s+/g, " ");
    return { ok: false, error: `MAERSK HTTP ${result.status} — preview: ${preview}`, carrier: "MAERSK" };
  }

  let data;
  try { data = JSON.parse(result.body); }
  catch (e) { return { ok: false, error: "MAERSK: invalid JSON response", carrier: "MAERSK" }; }

  const containers = Array.isArray(data.containers) ? data.containers : [];
  if (containers.length === 0) {
    return { ok: false, error: "MAERSK: no containers in response", carrier: "MAERSK" };
  }

  // For container search, API returns just that container. For booking/MBL,
  // returns all containers in the shipment — one card each (matches MSC/CMA).
  const cards = containers.map(c => _maerskNormalizeContainer(c, data, reference, refType));
  return cards.length === 1 ? cards[0] : cards;
}

async function maerskBookingTrack(reference) { return _maerskTrack(reference, "booking"); }
async function maerskMblTrack(reference)     { return _maerskTrack(reference, "mbl"); }
async function maerskCntrTrack(reference)    { return _maerskTrack(reference, "cntr"); }

// ============================================================================
// HMM
// ============================================================================
async function hmmBookingTrack(reference) {
  return notImplemented("HMM", "booking");
}
async function hmmMblTrack(reference) {
  return notImplemented("HMM", "MBL");
}
async function hmmCntrTrack(reference) {
  return notImplemented("HMM", "container");
}

// ============================================================================
// EVERGREEN (EMC)
// ============================================================================
async function emcBookingTrack(reference) {
  return notImplemented("EMC", "booking");
}
async function emcMblTrack(reference) {
  return notImplemented("EMC", "MBL");
}
async function emcCntrTrack(reference) {
  return notImplemented("EMC", "container");
}

// ============================================================================
// HAPAG-LLOYD (HPL)
// ============================================================================
async function hplBookingTrack(reference) {
  return notImplemented("HPL", "booking");
}
async function hplMblTrack(reference) {
  return notImplemented("HPL", "MBL");
}
async function hplCntrTrack(reference) {
  return notImplemented("HPL", "container");
}

// ============================================================================
// ZIM
// ============================================================================
async function zimBookingTrack(reference) {
  return notImplemented("ZIM", "booking");
}
async function zimMblTrack(reference) {
  return notImplemented("ZIM", "MBL");
}
async function zimCntrTrack(reference) {
  return notImplemented("ZIM", "container");
}

// ============================================================================
// ONE
// ============================================================================
async function oneBookingTrack(reference) {
  return notImplemented("ONE", "booking");
}
async function oneMblTrack(reference) {
  return notImplemented("ONE", "MBL");
}
async function oneCntrTrack(reference) {
  return notImplemented("ONE", "container");
}

// ============================================================================
// COSCO
// ============================================================================
async function coscoBookingTrack(reference) {
  return notImplemented("COSCO", "booking");
}
async function coscoMblTrack(reference) {
  return notImplemented("COSCO", "MBL");
}
async function coscoCntrTrack(reference) {
  return notImplemented("COSCO", "container");
}

// ============================================================================
// REGISTRY — single source of truth: which carriers exist + their handlers
// ============================================================================
// Adding a new carrier? Add a row here and 3 stub functions above. Frontend
// auto-discovers carriers via GET /api/track/carriers, so no other change.
const TRACKER_REGISTRY = {
  MSC:    { booking: mscBookingTrack,    mbl: mscMblTrack,    cntr: mscCntrTrack    },
  CMA:    { booking: cmaBookingTrack,    mbl: cmaMblTrack,    cntr: cmaCntrTrack    },
  MAERSK: { booking: maerskBookingTrack, mbl: maerskMblTrack, cntr: maerskCntrTrack },
  HMM:    { booking: hmmBookingTrack,    mbl: hmmMblTrack,    cntr: hmmCntrTrack    },
  EMC:    { booking: emcBookingTrack,    mbl: emcMblTrack,    cntr: emcCntrTrack    },
  HPL:    { booking: hplBookingTrack,    mbl: hplMblTrack,    cntr: hplCntrTrack    },
  ZIM:    { booking: zimBookingTrack,    mbl: zimMblTrack,    cntr: zimCntrTrack    },
  ONE:    { booking: oneBookingTrack,    mbl: oneMblTrack,    cntr: oneCntrTrack    },
  COSCO:  { booking: coscoBookingTrack,  mbl: coscoMblTrack,  cntr: coscoCntrTrack  },
};

const CARRIER_DISPLAY_NAMES = {
  MSC: "MSC", CMA: "CMA CGM", MAERSK: "Maersk", HMM: "HMM",
  EMC: "Evergreen", HPL: "Hapag-Lloyd", ZIM: "ZIM", ONE: "ONE", COSCO: "COSCO",
};

/**
 * Track a reference across ALL carriers in parallel for the given type.
 * Returns array of result objects (one per carrier, in registry order).
 * Successful results have { ok:true, ... }; failures have { ok:false, error, carrier }.
 *
 * Frontend should:
 *   - render all { ok:true } results
 *   - silently ignore { ok:false, notConfigured:true }
 *   - optionally show "no carrier matched" if zero successes
 */
async function trackAcrossAllCarriers(refType, reference) {
  if (!["booking", "mbl", "cntr"].includes(refType)) {
    throw new Error(`Invalid refType: ${refType}`);
  }
  const carriers = Object.keys(TRACKER_REGISTRY);
  const raw = await Promise.all(
    carriers.map(c => withTimeout(
      TRACKER_REGISTRY[c][refType](reference).then(r => {
        // A tracker may return either a single result or an array (e.g. MSC
        // booking with multiple containers — one card per container).
        if (Array.isArray(r)) return r.map(x => ({ ...x, carrier: x.carrier || c }));
        return { ...r, carrier: r.carrier || c };
      }),
      12000,
      c
    ))
  );
  // Flatten any arrays returned by trackers
  const results = [];
  for (const r of raw) {
    if (Array.isArray(r)) results.push(...r);
    else results.push(r);
  }
  return results;
}

module.exports = {
  TRACKER_REGISTRY,
  CARRIER_DISPLAY_NAMES,
  trackAcrossAllCarriers,
  // Export individual trackers too in case caller wants a single-carrier hit
  mscBookingTrack, mscMblTrack, mscCntrTrack,
  cmaBookingTrack, cmaMblTrack, cmaCntrTrack,
  maerskBookingTrack, maerskMblTrack, maerskCntrTrack,
  hmmBookingTrack, hmmMblTrack, hmmCntrTrack,
  emcBookingTrack, emcMblTrack, emcCntrTrack,
  hplBookingTrack, hplMblTrack, hplCntrTrack,
  zimBookingTrack, zimMblTrack, zimCntrTrack,
  oneBookingTrack, oneMblTrack, oneCntrTrack,
  coscoBookingTrack, coscoMblTrack, coscoCntrTrack,
};
