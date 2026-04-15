/**
 * Merge network-detected stream URLs with DOM URLs per tab; update badge.
 */
const tabStreams = new Map(); // tabId -> Map url -> { label, kind }

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
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStreams.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    tabStreams.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: "" });
  }
});
