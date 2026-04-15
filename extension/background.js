/**
 * Merge network-detected stream URLs with DOM URLs per tab; update badge.
 * Jobs + page info cache persist in chrome.storage.local (survives SW restarts + extension reloads).
 */
const tabStreams = new Map();
const activeJobs = new Map();

const JOBS_KEY = "reclipJobs";
const PAGE_INFO_KEY = "reclipPageInfo";

/** Migrate tabId-keyed map to jobId-keyed (one global list of jobs). */
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

async function removeJobFromStorageByJobId(jobId) {
  const m = await loadJobsMap();
  delete m[jobId];
  await saveJobsMap(m);
}

function addUrl(tabId, url, meta = {}) {
  if (!url || !tabId || tabId < 0) return;
  if (!tabStreams.has(tabId)) tabStreams.set(tabId, new Map());
  const m = tabStreams.get(tabId);
  if (!m.has(url)) m.set(url, { label: meta.label || url.slice(0, 80), kind: meta.kind || "network" });
  updateBadge(tabId);
}

/** Badge flash timers (done/error) per tab. */
const badgeFlashTimers = new Map();

function clearBadgeFlash(tabId) {
  const t = badgeFlashTimers.get(tabId);
  if (t) {
    clearTimeout(t);
    badgeFlashTimers.delete(tabId);
  }
}

/** Max 4 chars for chrome.action badge text. */
function jobBadgeText(job) {
  if (!job || job.status !== "downloading") return "";
  const p = job.progress;
  if (typeof p === "number" && !Number.isNaN(p) && p > 0) {
    const n = Math.round(p);
    const s = n >= 100 ? "99" : String(Math.min(99, n));
    return s.length <= 4 ? s : s.slice(0, 4);
  }
  return "DL";
}

/**
 * Stream count badge (orange) or job badge (blue) when a download is active for this tab.
 */
function refreshActionBadge(tabId) {
  clearBadgeFlash(tabId);
  const job = activeJobs.get(tabId);
  if (job && job.status === "downloading") {
    const text = jobBadgeText(job);
    chrome.action.setBadgeText({ tabId, text: text || "DL" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#2196F3" });
    return;
  }
  const m = tabStreams.get(tabId);
  const n = m ? m.size : 0;
  chrome.action.setBadgeText({ tabId, text: n > 0 ? String(Math.min(n, 99)) : "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#e85d2a" });
}

function flashBadgeThenRestore(tabId, kind) {
  clearBadgeFlash(tabId);
  if (kind === "ok") {
    chrome.action.setBadgeText({ tabId, text: "OK" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#2e7d32" });
  } else {
    chrome.action.setBadgeText({ tabId, text: "!" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#c62828" });
  }
  const t = setTimeout(() => {
    badgeFlashTimers.delete(tabId);
    refreshActionBadge(tabId);
  }, 3000);
  badgeFlashTimers.set(tabId, t);
}

function updateBadge(tabId) {
  refreshActionBadge(tabId);
}

function clearTab(tabId) {
  tabStreams.delete(tabId);
  clearBadgeFlash(tabId);
  chrome.action.setBadgeText({ tabId, text: "" });
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
// Job polling (background-side)
// ---------------------------------------------------------------------------

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
      if (j._interval) clearInterval(j._interval);
      j._interval = null;
      j.filename = data.filename;
      j.status = "done";
      await persistJobSnapshot(tabId, j);
      flashBadgeThenRestore(tabId, "ok");
      activeJobs.delete(tabId);
      return;
    }
    if (data.status === "error" || data.status === "cancelled") {
      if (j._interval) clearInterval(j._interval);
      j._interval = null;
      j.error = data.error;
      j.status = data.status;
      await persistJobSnapshot(tabId, j);
      flashBadgeThenRestore(tabId, "error");
      activeJobs.delete(tabId);
      return;
    }
    await persistJobSnapshot(tabId, j);
    refreshActionBadge(tabId);
  } catch {
    if (j._interval) clearInterval(j._interval);
    j._interval = null;
    j.status = "error";
    j.error = "Lost connection to server";
    await persistJobSnapshot(tabId, j);
    flashBadgeThenRestore(tabId, "error");
    activeJobs.delete(tabId);
  }
}

function startJobPolling(tabId) {
  const job = activeJobs.get(tabId);
  if (!job || job._interval) return;

  refreshActionBadge(tabId);
  void pollJobTick(tabId);

  job._interval = setInterval(() => {
    void pollJobTick(tabId);
  }, 1200);
}

async function ensureJobPolling(tabId) {
  if (activeJobs.has(tabId) && activeJobs.get(tabId)._interval) return;

  const m = await loadJobsMap();
  let raw = null;
  for (const j of Object.values(m)) {
    if (String(j.tabId) === String(tabId) && j.status === "downloading") {
      raw = j;
      break;
    }
  }
  if (!raw) return;

  const job = { ...raw, _interval: null };
  activeJobs.set(tabId, job);
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
    const prev = activeJobs.get(tabId);
    if (prev && prev._interval) clearInterval(prev._interval);

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
      _interval: null,
    };
    activeJobs.set(tabId, job);
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
    const j = activeJobs.get(tabId);
    if (j && j._interval) clearInterval(j._interval);
    if (j) j._interval = null;
    activeJobs.delete(tabId);
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
  clearBadgeFlash(tabId);
  tabStreams.delete(tabId);
  lastTabUrl.delete(tabId);
  const job = activeJobs.get(tabId);
  if (job && job._interval) clearInterval(job._interval);
  activeJobs.delete(tabId);
  (async () => {
    const m = await loadPageInfoMap();
    delete m[String(tabId)];
    await savePageInfoMap(m);
  })();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") {
    tabStreams.delete(tabId);
    refreshActionBadge(tabId);
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
