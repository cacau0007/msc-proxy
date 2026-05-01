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
const MSC_TRACK_REFERER = "https://www.msc.com/pt/track-a-shipment";

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
    "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    "Origin": "https://www.msc.com",
    "Referer": MSC_TRACK_REFERER,
    "x-requested-with": "XMLHttpRequest",
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
async function cmaBookingTrack(reference) {
  return notImplemented("CMA", "booking");
}
async function cmaMblTrack(reference) {
  return notImplemented("CMA", "MBL");
}
async function cmaCntrTrack(reference) {
  return notImplemented("CMA", "container");
}

// ============================================================================
// MAERSK
// ============================================================================
async function maerskBookingTrack(reference) {
  return notImplemented("MAERSK", "booking");
}
async function maerskMblTrack(reference) {
  return notImplemented("MAERSK", "MBL");
}
async function maerskCntrTrack(reference) {
  return notImplemented("MAERSK", "container");
}

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
