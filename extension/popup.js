const STORAGE_KEY = "reclipServerUrl";

/** @type {boolean} */
let streamsExpanded = false;
/** @type {number} */
let lastStreamCount = 0;

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
  document.querySelectorAll(".dl-row-btn").forEach((b) => {
    b.disabled = busy;
  });
  document.querySelectorAll("#formatPills .pill").forEach((b) => {
    b.disabled = busy;
  });
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

async function pollUntilDone(serverUrl, jobId) {
  const max = 600;
  for (let i = 0; i < max; i++) {
    const res = await fetch(`${serverUrl}/api/status/${jobId}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Status failed");
    if (data.status === "done") return data;
    if (data.status === "error") throw new Error(data.error || "Download failed");
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Timeout waiting for download");
}

async function triggerBrowserDownload(serverUrl, jobId, filename) {
  const url = `${serverUrl}/api/file/${jobId}`;
  await chrome.downloads.download({
    url,
    filename: filename || undefined,
    saveAs: false,
  });
}

function pickDownloadUrl(streams, pageUrl) {
  if (!streams || !streams.length) return pageUrl;
  const net = streams.find(
    (s) =>
      s.kind === "network" &&
      /\.(m3u8|mpd|mp4|webm|m4v)(\?|$|#)/i.test(s.url)
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
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {}
  const k = (kind || "").toLowerCase();
  if (k === "embed") {
    if (url.includes("youtube.com") || url.includes("youtu.be")) return "Embed · YouTube";
    if (url.includes("vimeo.com")) return "Embed · Vimeo";
    return host ? `Embed · ${host}` : "Embed";
  }
  const map = {
    page: "Page",
    video: "Video",
    source: "Source",
    network: "Stream",
    embed: "Embed",
    dom: "Item",
  };
  const t = map[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : "Item");
  return host ? `${t} · ${host}` : t;
}

function shortUrlPreview(url) {
  try {
    const u = new URL(url);
    let path = u.pathname + u.search;
    if (path.length > 64) path = path.slice(0, 62) + "…";
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
    out.push({
      ...s,
      displayLine: humanLabel(s.kind, s.url),
      urlPreview: shortUrlPreview(s.url),
    });
    if (out.length >= 5) break;
  }
  return out;
}

async function runDownload(targetUrl) {
  const serverUrl = await getServerUrl();
  if (!serverUrl) {
    showStatus("Configure server URL first.", "error", false);
    return;
  }
  showStatus("Sending to ReClip…", "", true);
  const btnDl = $("btnDownloadPage");
  const btnPaste = $("btnPasteSend");
  if (btnDl) btnDl.disabled = true;
  if (btnPaste) btnPaste.disabled = true;
  setDownloadUiBusy(true);
  try {
    const fmt = currentFormat();
    const data = await apiDownload(serverUrl, {
      url: targetUrl,
      format: fmt === "audio" ? "audio" : "video",
      title: "",
      thumbnail: "",
      uploader: "",
      duration: null,
    });
    const jobId = data.job_id;
    if (!jobId) throw new Error("No job_id");
    showStatus("Downloading on server…", "", true);
    const st = await pollUntilDone(serverUrl, jobId);
    showStatus("Saving to device…", "", true);
    await triggerBrowserDownload(serverUrl, jobId, st.filename);
    showStatus("Done.", "ok", false);
  } catch (e) {
    showStatus(e.message || String(e), "error", false);
  } finally {
    if (btnDl) btnDl.disabled = false;
    if (btnPaste) btnPaste.disabled = false;
    setDownloadUiBusy(false);
  }
}

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
    list.innerHTML = '<p class="hint">Nothing to list (or only page URL — use Download this page).</p>';
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
      const u =
        s.kind === "network" && /\.(m3u8|mpd|mp4|webm|m4v)(\?|$|#)/i.test(s.url) ? s.url : pageUrl;
      runDownload(u);
    });

    wrap.appendChild(text);
    wrap.appendChild(btn);
    list.appendChild(wrap);
  });
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

function trunc(s, n) {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n) + "…";
}

async function refreshStreams() {
  const serverUrl = await getServerUrl();
  $("serverHint").textContent = serverUrl ? `Server: ${serverUrl}` : "";

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.id) return;
    const pageUrl = tab.url || "";
    chrome.runtime.sendMessage({ type: "RECLIP_GET_STREAMS", tabId: tab.id }, (resp) => {
      const streams = (resp && resp.streams) || [];
      renderStreams(streams, pageUrl);
      const btnDl = $("btnDownloadPage");
      if (btnDl) {
        btnDl.onclick = () => runDownload(pickDownloadUrl(streams, pageUrl));
      }
    });
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
