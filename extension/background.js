/**
 * Merge network-detected stream URLs with DOM URLs per tab; update badge.
 * Manage active download jobs so they survive popup close/reopen.
 */
const tabStreams = new Map();
const activeJobs = new Map();

function addUrl(tabId, url, meta = {}) {
  if (!url || !tabId || tabId < 0) return;
  if (!tabStreams.has(tabId)) tabStreams.set(tabId, new Map());
  const m = tabStreams.get(tabId);
  if (!m.has(url)) m.set(url, { label: meta.label || url.slice(0, 80), kind: meta.kind || "network" });
  updateBadge(tabId);
}

function updateBadge(tabId) {
  const m = tabStreams.get(tabId);
  const n = m ? m.size : 0;
  chrome.action.setBadgeText({ tabId, text: n > 0 ? String(Math.min(n, 99)) : "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#e85d2a" });
}

function clearTab(tabId) {
  tabStreams.delete(tabId);
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
// Job polling (background-side, survives popup close)
// ---------------------------------------------------------------------------

function startJobPolling(tabId) {
  const job = activeJobs.get(tabId);
  if (!job || job._interval) return;

  job._interval = setInterval(async () => {
    try {
      const res = await fetch(`${job.serverUrl}/api/status/${job.jobId}`);
      const data = await res.json();
      job.status = data.status || job.status;
      job.progress = data.progress ?? job.progress;
      job.progress_text = data.progress_text || job.progress_text;
      if (data.status === "done") {
        clearInterval(job._interval);
        job._interval = null;
        job.filename = data.filename;
      } else if (data.status === "error") {
        clearInterval(job._interval);
        job._interval = null;
        job.error = data.error;
      }
    } catch {
      clearInterval(job._interval);
      job._interval = null;
      job.status = "error";
      job.error = "Lost connection to server";
    }
  }, 1200);
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
    return true;
  }

  if (msg.type === "RECLIP_GET_STREAMS") {
    const tabId = msg.tabId;
    const m = tabStreams.get(tabId);
    const list = m
      ? Array.from(m.entries()).map(([url, meta]) => ({ url, ...meta }))
      : [];
    sendResponse({ streams: list });
    return true;
  }

  if (msg.type === "RECLIP_CLEAR_TAB") {
    clearTab(msg.tabId);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "RECLIP_START_JOB") {
    const tabId = msg.tabId;
    const prev = activeJobs.get(tabId);
    if (prev && prev._interval) clearInterval(prev._interval);

    activeJobs.set(tabId, {
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
      _interval: null,
    });
    startJobPolling(tabId);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "RECLIP_GET_JOB") {
    const job = activeJobs.get(msg.tabId);
    if (!job) {
      sendResponse({ job: null });
    } else {
      sendResponse({
        job: {
          jobId: job.jobId,
          serverUrl: job.serverUrl,
          status: job.status,
          progress: job.progress,
          progress_text: job.progress_text,
          filename: job.filename,
          error: job.error,
          url: job.url,
          title: job.title,
          thumbnail: job.thumbnail,
        },
      });
    }
    return true;
  }
});

// ---------------------------------------------------------------------------
// Tab lifecycle
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStreams.delete(tabId);
  const job = activeJobs.get(tabId);
  if (job && job._interval) clearInterval(job._interval);
  activeJobs.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    tabStreams.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: "" });
  }
});
