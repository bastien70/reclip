/**
 * Merge network-detected stream URLs with DOM URLs per tab; update badge.
 * Jobs + page info cache persist in chrome.storage.local (survives SW restarts + extension reloads).
 * Polling uses chrome.alarms to survive MV3 service-worker idle shutdown.
 */
const tabStreams = new Map();
const activeJobs = new Map();

const JOBS_KEY = "reclipJobs";
const PAGE_INFO_KEY = "reclipPageInfo";
const ALARM_PREFIX = "reclip-poll-";
const POLL_PERIOD_MIN = 0.05; // ~3 seconds (minimum Chrome allows in dev)

function migrateJobsMap(raw) {
  if (!raw || typeof raw !== "object") return {};
  const keys = Object.keys(raw);
  if (keys.length === 0) return {};
  const firstKey = keys[0];
  const first = raw[firstKey];
  if (!first || typeof first !== "object" || !first.jobId) return raw;
  if (firstKey === first.jobId) return raw;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v && v.jobId) {
      out[v.jobId] = {
        ...v,
        tabId: v.tabId != null ? v.tabId : /^\d+$/.test(String(k)) ? Number(k) : k,
      };
    }
  }
  return out;
}

async function loadJobsMap() {
  const r = await chrome.storage.local.get(JOBS_KEY);
  const raw = r[JOBS_KEY] || {};
  const migrated = migrateJobsMap(raw);
  const wasOld =
    Object.keys(raw).length > 0 &&
    Object.keys(raw).some((k) => {
      const v = raw[k];
      return v && v.jobId && k !== v.jobId;
    });
  if (wasOld) {
    await chrome.storage.local.set({ [JOBS_KEY]: migrated });
  }
  return migrated;
}

async function saveJobsMap(m) {
  await chrome.storage.local.set({ [JOBS_KEY]: m });
}

async function loadPageInfoMap() {
  const r = await chrome.storage.local.get(PAGE_INFO_KEY);
  return r[PAGE_INFO_KEY] || {};
}

async function savePageInfoMap(m) {
  await chrome.storage.local.set({ [PAGE_INFO_KEY]: m });
}

async function persistJobSnapshot(tabId, job) {
  const m = await loadJobsMap();
  const jid = job.jobId;
  if (!jid) return;
  const copy = { ...job };
  delete copy._interval;
  const prev = m[jid];
  if (prev && prev.savedToDevice) {
    copy.savedToDevice = true;
  }
  m[jid] = { ...prev, ...copy, tabId };
  await saveJobsMap(m);
}

function addUrl(tabId, url, meta = {}) {
  if (!url || !tabId || tabId < 0) return;
  if (!tabStreams.has(tabId)) tabStreams.set(tabId, new Map());
  const m = tabStreams.get(tabId);
  if (!m.has(url)) m.set(url, { label: meta.label || url.slice(0, 80), kind: meta.kind || "network" });
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

let badgeFlashTimer = null;

function clearBadgeFlash() {
  if (badgeFlashTimer) {
    clearTimeout(badgeFlashTimer);
    badgeFlashTimer = null;
  }
}

function jobBadgeText(job) {
  if (!job || job.status !== "downloading") return "";
  const p = job.progress;
  if (typeof p === "number" && !Number.isNaN(p) && p > 0) {
    const n = Math.round(p);
    return n >= 100 ? "99" : String(Math.min(99, n));
  }
  return "DL";
}

/**
 * Global badge: if ANY tab has an active download, show blue badge with progress.
 * Otherwise clear.
 */
function refreshActionBadge() {
  clearBadgeFlash();
  for (const [, job] of activeJobs) {
    if (job && job.status === "downloading") {
      const text = jobBadgeText(job) || "DL";
      chrome.action.setBadgeText({ text });
      chrome.action.setBadgeBackgroundColor({ color: "#2196F3" });
      return;
    }
  }
  chrome.action.setBadgeText({ text: "" });
}

function flashBadgeThenRestore(tabId, kind) {
  clearBadgeFlash();
  if (kind === "ok") {
    chrome.action.setBadgeText({ text: "\u2713" });
    chrome.action.setBadgeBackgroundColor({ color: "#2e7d32" });
  } else {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#c62828" });
  }
  badgeFlashTimer = setTimeout(() => {
    badgeFlashTimer = null;
    refreshActionBadge();
  }, 3000);
}

function updateBadge() {
  refreshActionBadge();
}

function clearTab(tabId) {
  tabStreams.delete(tabId);
}

// ---------------------------------------------------------------------------
// Network stream detection
// ---------------------------------------------------------------------------

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const u = details.url;
    const lower = u.toLowerCase();
    if (/\.(m3u8|mpd)(\?|$|#)/i.test(lower) || /\.(mp4|webm|m4v|mkv)(\?|$|#)/i.test(lower)) {
      addUrl(details.tabId, u, { label: "Stream", kind: "network" });
    }
  },
  { urls: ["<all_urls>"] },
  []
);

// ---------------------------------------------------------------------------
// Job polling via chrome.alarms (survives SW idle shutdown)
// ---------------------------------------------------------------------------

function alarmName(tabId) {
  return ALARM_PREFIX + tabId;
}

function tabIdFromAlarm(name) {
  if (!name.startsWith(ALARM_PREFIX)) return null;
  const n = Number(name.slice(ALARM_PREFIX.length));
  return Number.isNaN(n) ? null : n;
}

async function pollJobTick(tabId) {
  const j = activeJobs.get(tabId);
  if (!j || !j.jobId) return;
  try {
    const res = await fetch(`${j.serverUrl}/api/status/${j.jobId}`);
    const data = await res.json();
    j.status = data.status || j.status;
    j.progress = data.progress ?? j.progress;
    j.progress_text = data.progress_text || j.progress_text;
    if (data.status === "done") {
      j.filename = data.filename;
      j.status = "done";
      await persistJobSnapshot(tabId, j);
      stopJobPolling(tabId);
      flashBadgeThenRestore(tabId, "ok");
      return;
    }
    if (data.status === "error" || data.status === "cancelled") {
      j.error = data.error;
      j.status = data.status;
      await persistJobSnapshot(tabId, j);
      stopJobPolling(tabId);
      flashBadgeThenRestore(tabId, "error");
      return;
    }
    await persistJobSnapshot(tabId, j);
    refreshActionBadge();
  } catch {
    j.status = "error";
    j.error = "Lost connection to server";
    await persistJobSnapshot(tabId, j);
    stopJobPolling(tabId);
    flashBadgeThenRestore(tabId, "error");
  }
}

function startJobPolling(tabId) {
  const job = activeJobs.get(tabId);
  if (!job) return;
  refreshActionBadge();
  void pollJobTick(tabId);
  chrome.alarms.create(alarmName(tabId), { periodInMinutes: POLL_PERIOD_MIN });
}

function stopJobPolling(tabId) {
  activeJobs.delete(tabId);
  chrome.alarms.clear(alarmName(tabId));
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const tabId = tabIdFromAlarm(alarm.name);
  if (tabId == null) return;

  if (!activeJobs.has(tabId)) {
    const m = await loadJobsMap();
    let raw = null;
    for (const j of Object.values(m)) {
      if (String(j.tabId) === String(tabId) && j.status === "downloading") {
        raw = j;
        break;
      }
    }
    if (!raw) {
      chrome.alarms.clear(alarm.name);
      return;
    }
    activeJobs.set(tabId, { ...raw });
  }

  await pollJobTick(tabId);
});

async function ensureJobPolling(tabId) {
  if (activeJobs.has(tabId)) {
    refreshActionBadge();
    return;
  }

  const m = await loadJobsMap();
  let raw = null;
  for (const j of Object.values(m)) {
    if (String(j.tabId) === String(tabId) && j.status === "downloading") {
      raw = j;
      break;
    }
  }
  if (!raw) return;

  activeJobs.set(tabId, { ...raw });
  startJobPolling(tabId);
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "RECLIP_DOM_URLS" && sender.tab) {
    const tabId = sender.tab.id;
    msg.urls.forEach((item) => {
      addUrl(tabId, item.url, { label: item.label || item.kind, kind: item.kind || "dom" });
    });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "RECLIP_GET_STREAMS") {
    const tabId = msg.tabId;
    const m = tabStreams.get(tabId);
    const list = m
      ? Array.from(m.entries()).map(([url, meta]) => ({ url, ...meta }))
      : [];
    sendResponse({ streams: list });
    return false;
  }

  if (msg.type === "RECLIP_CLEAR_TAB") {
    clearTab(msg.tabId);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "RECLIP_START_JOB") {
    const tabId = msg.tabId;
    stopJobPolling(tabId);

    const job = {
      jobId: msg.jobId,
      serverUrl: msg.serverUrl,
      url: msg.url || "",
      title: msg.title || "",
      thumbnail: msg.thumbnail || "",
      status: "downloading",
      progress: 0,
      progress_text: "",
      filename: null,
      error: null,
      savedToDevice: false,
    };
    activeJobs.set(tabId, job);
    refreshActionBadge();
    persistJobSnapshot(tabId, job).then(() => {
      startJobPolling(tabId);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "RECLIP_ENSURE_POLLING") {
    ensureJobPolling(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "RECLIP_STOP_POLLING_FOR_TAB") {
    const tabId = msg.tabId;
    stopJobPolling(tabId);
    refreshActionBadge();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// ---------------------------------------------------------------------------
// URL comparison (same video page)
// ---------------------------------------------------------------------------

function samePageUrl(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    if (ua.origin !== ub.origin || ua.pathname !== ub.pathname) return false;
    const va = ua.searchParams.get("v");
    const vb = ub.searchParams.get("v");
    if (va && vb) return va === vb;
    return ua.search === ub.search;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tab lifecycle
// ---------------------------------------------------------------------------

const lastTabUrl = new Map();

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStreams.delete(tabId);
  lastTabUrl.delete(tabId);
  stopJobPolling(tabId);
  (async () => {
    const m = await loadPageInfoMap();
    delete m[String(tabId)];
    await savePageInfoMap(m);
  })();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") {
    tabStreams.delete(tabId);
  }
  if (changeInfo.url) {
    const prev = lastTabUrl.get(tabId);
    lastTabUrl.set(tabId, changeInfo.url);
    if (prev && samePageUrl(prev, changeInfo.url)) return;

    (async () => {
      const m = await loadPageInfoMap();
      delete m[String(tabId)];
      await savePageInfoMap(m);
    })();
  }
});
