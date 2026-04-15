const STORAGE_KEY = "reclipServerUrl";

let streamsExpanded = false;
let lastStreamCount = 0;
let lastInfo = null;
let selectedFormatId = null;
let currentTabId = null;
let currentPageUrl = "";

function $(id) {
  return document.getElementById(id);
}

function showStatus(text, kind, loading) {
  const row = $("statusRow");
  const spin = $("statusSpinner");
  const el = $("status");
  if (el) {
    el.textContent = text || "";
    el.className = kind || "";
  }
  const showSpinner = !!loading;
  if (spin) spin.classList.toggle("hidden", !showSpinner);
  if (row) row.classList.toggle("visible", !!(text || showSpinner));
}

function setDownloadUiBusy(busy) {
  document.querySelectorAll(".dl-row-btn").forEach((b) => (b.disabled = busy));
  document.querySelectorAll("#formatPills .pill").forEach((b) => (b.disabled = busy));
  document.querySelectorAll("#infoFormats .q-chip").forEach((b) => (b.disabled = busy));
  const t = $("btnToggleStreams");
  if (t) t.disabled = busy;
}

function showStatusConfig(text, kind) {
  const el = $("statusConfig");
  if (!el) return;
  el.textContent = text || "";
  el.style.color = kind === "error" ? "var(--error)" : kind === "ok" ? "var(--success)" : "var(--muted)";
}

function normalizeBase(url) {
  if (!url) return "";
  let u = url.trim();
  if (!u.startsWith("http")) u = "http://" + u;
  return u.replace(/\/$/, "");
}

async function getServerUrl() {
  return new Promise((resolve) => {
    chrome.storage.sync.get([STORAGE_KEY], (r) => {
      resolve(normalizeBase(r[STORAGE_KEY] || ""));
    });
  });
}

function setServerUrl(url) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [STORAGE_KEY]: normalizeBase(url) }, resolve);
  });
}

function currentFormat() {
  const active = document.querySelector("#formatPills .pill.active");
  return active ? active.dataset.format : "video";
}

function fmtDur(s) {
  if (!s) return "";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

async function apiDownload(serverUrl, body) {
  const res = await fetch(`${serverUrl}/api/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || "Request failed");
  return data;
}

async function triggerBrowserDownload(serverUrl, jobId, filename) {
  const url = `${serverUrl}/api/file/${jobId}`;
  await chrome.downloads.download({ url, filename: filename || undefined, saveAs: false });
}

function pickDownloadUrl(streams, pageUrl) {
  if (!streams || !streams.length) return pageUrl;
  const net = streams.find(
    (s) => s.kind === "network" && /\.(m3u8|mpd|mp4|webm|m4v)(\?|$|#)/i.test(s.url)
  );
  if (net) return net.url;
  return pageUrl;
}

function dedupeKey(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "blob:") return null;
    const h = u.hostname;
    const p = u.pathname;
    const amp = p.match(/\/(?:amplify_video|ext_tw_video)\/(\d+)/);
    if (amp && h.includes("twimg")) return `${h}/vid/${amp[1]}`;
    const base = p.replace(/\/[^/]+\.(m3u8|mpd|mp4|webm|m4v|ts)(\?.*)?$/i, "");
    return h + base;
  } catch {
    return url;
  }
}

function humanLabel(kind, url) {
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch {}
  const k = (kind || "").toLowerCase();
  if (k === "embed") {
    if (url.includes("youtube.com") || url.includes("youtu.be")) return "Embed \u00b7 YouTube";
    if (url.includes("vimeo.com")) return "Embed \u00b7 Vimeo";
    return host ? `Embed \u00b7 ${host}` : "Embed";
  }
  const map = { page: "Page", video: "Video", source: "Source", network: "Stream", embed: "Embed", dom: "Item" };
  const t = map[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : "Item");
  return host ? `${t} \u00b7 ${host}` : t;
}

function shortUrlPreview(url) {
  try {
    const u = new URL(url);
    let path = u.pathname + u.search;
    if (path.length > 64) path = path.slice(0, 62) + "\u2026";
    return u.hostname + path;
  } catch {
    return trunc(url, 80);
  }
}

function prepareStreams(streams) {
  const seen = new Set();
  const out = [];
  for (const s of streams) {
    if (!s.url || s.url.startsWith("blob:")) continue;
    const key = dedupeKey(s.url);
    if (key === null) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...s, displayLine: humanLabel(s.kind, s.url), urlPreview: shortUrlPreview(s.url) });
    if (out.length >= 5) break;
  }
  return out;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

function trunc(s, n) {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n) + "\u2026";
}

// ---------------------------------------------------------------------------
// Info card (auto-fetch /api/info)
// ---------------------------------------------------------------------------

function showInfoLoading() {
  const card = $("infoCard");
  const thumb = $("infoThumbWrap");
  const title = $("infoTitle");
  const meta = $("infoMeta");
  const fmts = $("infoFormats");
  card.className = "loading";
  if (thumb) thumb.innerHTML = '<div class="skeleton" style="width:100%;height:100%"></div>';
  if (title) title.innerHTML = '<div class="skel-line medium skeleton"></div>';
  if (meta) meta.innerHTML = '<div class="skel-line short skeleton"></div>';
  if (fmts) fmts.innerHTML = "";
}

function showInfoCard(info) {
  const title = $("infoTitle");
  const meta = $("infoMeta");
  const fmts = $("infoFormats");
  const thumb = $("infoThumbWrap");
  const card = $("infoCard");
  if (!title || !meta || !fmts || !thumb || !card) return;

  lastInfo = info;
  selectedFormatId = info.formats?.[0]?.id || null;

  card.className = "visible";

  if (info.thumbnail) {
    thumb.innerHTML = `<img src="${escapeHtml(info.thumbnail)}" alt="">`;
  } else {
    thumb.innerHTML =
      '<div class="placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="20" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m21 15-5-5L5 21"/></svg></div>';
  }

  title.textContent = info.title || "Untitled";
  title.title = info.title || "";

  const parts = [];
  if (info.uploader) parts.push(info.uploader);
  if (info.duration) parts.push(fmtDur(info.duration));
  meta.textContent = parts.join(" \u00b7 ");

  if (info.formats && info.formats.length > 1) {
    fmts.innerHTML = info.formats
      .map((f) => `<button type="button" class="q-chip${f.id === selectedFormatId ? " active" : ""}" data-fid="${escapeHtml(f.id)}">${escapeHtml(f.label)}</button>`)
      .join("");
    fmts.querySelectorAll(".q-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedFormatId = btn.dataset.fid;
        fmts.querySelectorAll(".q-chip").forEach((b) => b.classList.toggle("active", b.dataset.fid === selectedFormatId));
      });
    });
  } else {
    fmts.innerHTML = "";
  }
}

function hideInfoCard() {
  const card = $("infoCard");
  if (card) card.className = "";
  lastInfo = null;
  selectedFormatId = null;
  const thumb = $("infoThumbWrap");
  const title = $("infoTitle");
  const meta = $("infoMeta");
  const fmts = $("infoFormats");
  if (thumb) thumb.innerHTML = "";
  if (title) title.textContent = "";
  if (meta) meta.textContent = "";
  if (fmts) fmts.innerHTML = "";
}

/** When /api/info fails: keep a visible card so the popup does not look empty. */
function showInfoFallback(detail) {
  const card = $("infoCard");
  const thumb = $("infoThumbWrap");
  const title = $("infoTitle");
  const meta = $("infoMeta");
  const fmts = $("infoFormats");
  if (!card || !thumb || !title || !meta || !fmts) return;
  card.className = "visible";
  lastInfo = null;
  selectedFormatId = null;
  thumb.innerHTML =
    '<div class="placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="20" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m21 15-5-5L5 21"/></svg></div>';
  title.textContent = "Could not load video details";
  const d = detail ? String(detail).trim() : "";
  meta.textContent = d
    ? trunc(d, 140)
    : "You can still tap Download this page \u2014 ReClip will use yt-dlp on the tab URL.";
  fmts.innerHTML = "";
}

async function fetchPageInfo(serverUrl, pageUrl) {
  showInfoLoading();
  try {
    const res = await fetch(`${serverUrl}/api/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: pageUrl }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const errMsg = data.error ? String(data.error) : `HTTP ${res.status}`;
      showInfoFallback(errMsg);
      return;
    }
    showInfoCard(data);
  } catch (e) {
    showInfoFallback(e && e.message ? e.message : "Network error \u2014 is the ReClip server reachable?");
  }
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

async function runDownload(targetUrl) {
  const serverUrl = await getServerUrl();
  if (!serverUrl) {
    showStatus("Configure server URL first.", "error", false);
    return;
  }
  showStatus("Sending to ReClip\u2026", "", true);
  const btnDl = $("btnDownloadPage");
  const btnPaste = $("btnPasteSend");
  if (btnDl) btnDl.disabled = true;
  if (btnPaste) btnPaste.disabled = true;
  setDownloadUiBusy(true);

  const fmt = currentFormat();
  const body = {
    url: targetUrl,
    format: fmt === "audio" ? "audio" : "video",
    format_id: selectedFormatId || undefined,
    title: lastInfo?.title || "",
    thumbnail: lastInfo?.thumbnail || "",
    uploader: lastInfo?.uploader || "",
    duration: lastInfo?.duration || null,
  };

  try {
    const data = await apiDownload(serverUrl, body);
    const jobId = data.job_id;
    if (!jobId) throw new Error("No job_id");

    chrome.runtime.sendMessage({
      type: "RECLIP_START_JOB",
      tabId: currentTabId,
      jobId,
      serverUrl,
      url: targetUrl,
      title: body.title,
      thumbnail: body.thumbnail,
    });

    showStatus("Downloading\u2026", "", true);
    startLocalPolling(serverUrl, jobId);
  } catch (e) {
    showStatus(e.message || String(e), "error", false);
    if (btnDl) btnDl.disabled = false;
    if (btnPaste) btnPaste.disabled = false;
    setDownloadUiBusy(false);
  }
}

function startLocalPolling(serverUrl, jobId) {
  const iv = setInterval(async () => {
    try {
      const res = await fetch(`${serverUrl}/api/status/${jobId}`);
      const data = await res.json().catch(() => ({}));
      if (data.status === "done") {
        clearInterval(iv);
        showStatus("Saving to device\u2026", "", true);
        await triggerBrowserDownload(serverUrl, jobId, data.filename);
        showStatus("Done.", "ok", false);
        finishDownloadUi();
      } else if (data.status === "error") {
        clearInterval(iv);
        showStatus(data.error || "Download failed", "error", false);
        finishDownloadUi();
      } else if (data.progress_text) {
        showStatus(`Downloading\u2026 ${data.progress_text}`, "", true);
      }
    } catch {
      clearInterval(iv);
      showStatus("Lost connection to server", "error", false);
      finishDownloadUi();
    }
  }, 1000);
}

function finishDownloadUi() {
  const btnDl = $("btnDownloadPage");
  const btnPaste = $("btnPasteSend");
  if (btnDl) btnDl.disabled = false;
  if (btnPaste) btnPaste.disabled = false;
  setDownloadUiBusy(false);
}

// ---------------------------------------------------------------------------
// Streams toggle
// ---------------------------------------------------------------------------

function updateStreamsToggleUi() {
  const btn = $("btnToggleStreams");
  const panel = $("streamsPanel");
  if (!btn || !panel) return;

  if (lastStreamCount === 0) {
    btn.textContent = "No extra streams detected";
    btn.disabled = true;
    panel.classList.add("hidden");
    streamsExpanded = false;
    btn.setAttribute("aria-expanded", "false");
    return;
  }

  btn.disabled = false;
  if (streamsExpanded) {
    btn.textContent = "Hide detected streams";
    panel.classList.remove("hidden");
    btn.setAttribute("aria-expanded", "true");
  } else {
    btn.textContent = `Show ${lastStreamCount} detected stream${lastStreamCount > 1 ? "s" : ""}`;
    panel.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
  }
}

function renderStreams(streams, pageUrl) {
  const list = $("streamList");
  list.innerHTML = "";
  const prepared = prepareStreams(streams);
  lastStreamCount = prepared.length;
  streamsExpanded = false;
  updateStreamsToggleUi();

  if (!prepared.length) {
    list.innerHTML = '<p class="hint">Nothing to list.</p>';
    return;
  }

  prepared.forEach((s) => {
    const wrap = document.createElement("div");
    wrap.className = "stream-row";

    const text = document.createElement("div");
    text.className = "stream-item";
    text.title = s.url;
    text.innerHTML = `<div class="meta">${escapeHtml(s.displayLine)}</div><div class="url-preview">${escapeHtml(s.urlPreview)}</div>`;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "small dl-row-btn";
    btn.textContent = "DL";
    btn.title = s.url;
    btn.addEventListener("click", () => {
      const u = s.kind === "network" && /\.(m3u8|mpd|mp4|webm|m4v)(\?|$|#)/i.test(s.url) ? s.url : pageUrl;
      runDownload(u);
    });

    wrap.appendChild(text);
    wrap.appendChild(btn);
    list.appendChild(wrap);
  });
}

// ---------------------------------------------------------------------------
// Restore active job from background
// ---------------------------------------------------------------------------

async function restoreActiveJob() {
  if (!currentTabId) return;
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "RECLIP_GET_JOB", tabId: currentTabId }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.job) {
        resolve(false);
        return;
      }
      const j = resp.job;
      if (j.status === "downloading") {
        showStatus(j.progress_text ? `Downloading\u2026 ${j.progress_text}` : "Downloading\u2026", "", true);
        const btnDl = $("btnDownloadPage");
        const btnPaste = $("btnPasteSend");
        if (btnDl) btnDl.disabled = true;
        if (btnPaste) btnPaste.disabled = true;
        setDownloadUiBusy(true);
        startLocalPolling(j.serverUrl, j.jobId);
        resolve(true);
      } else if (j.status === "done") {
        showStatus("Done.", "ok", false);
        triggerBrowserDownload(j.serverUrl, j.jobId, j.filename);
        resolve(true);
      } else if (j.status === "error") {
        showStatus(j.error || "Download failed", "error", false);
        resolve(true);
      } else {
        resolve(false);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function refreshStreams() {
  const serverUrl = await getServerUrl();
  $("serverHint").textContent = serverUrl ? `Server: ${serverUrl}` : "";

  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.id) return;
    currentTabId = tab.id;
    currentPageUrl = tab.url || "";

    chrome.runtime.sendMessage({ type: "RECLIP_GET_STREAMS", tabId: tab.id }, (resp) => {
      const streams = (resp && resp.streams) || [];
      renderStreams(streams, currentPageUrl);
      const btnDl = $("btnDownloadPage");
      if (btnDl) {
        btnDl.onclick = () => runDownload(pickDownloadUrl(streams, currentPageUrl));
      }
    });

    const restored = await restoreActiveJob();
    if (!restored && serverUrl && currentPageUrl.startsWith("http")) {
      fetchPageInfo(serverUrl, currentPageUrl);
    }
  });
}

function initFormatPills() {
  document.querySelectorAll("#formatPills .pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#formatPills .pill").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });
}

function initStreamsToggle() {
  const btn = $("btnToggleStreams");
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (lastStreamCount === 0) return;
    streamsExpanded = !streamsExpanded;
    updateStreamsToggleUi();
  });
}

async function showView() {
  const url = await getServerUrl();
  if (!url) {
    $("view-config").classList.remove("hidden");
    $("view-main").classList.add("hidden");
    $("serverUrl").value = "";
  } else {
    $("view-config").classList.add("hidden");
    $("view-main").classList.remove("hidden");
    $("serverUrl").value = url;
    refreshStreams();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initFormatPills();
  initStreamsToggle();

  $("btnSaveConfig").addEventListener("click", async () => {
    const v = $("serverUrl").value;
    if (!v.trim()) {
      showStatusConfig("Enter a server URL.", "error");
      return;
    }
    await setServerUrl(v);
    showStatusConfig("Saved.", "ok");
    await showView();
  });

  $("btnOpenSettings").addEventListener("click", () => {
    $("view-config").classList.remove("hidden");
    $("view-main").classList.add("hidden");
    getServerUrl().then((u) => {
      $("serverUrl").value = u;
    });
  });

  $("btnPasteSend").addEventListener("click", () => {
    const u = $("pasteUrl").value.trim();
    if (!u.startsWith("http")) {
      showStatus("Enter a valid http(s) URL.", "error", false);
      return;
    }
    runDownload(u);
  });

  showView();
});
