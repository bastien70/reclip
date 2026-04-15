const STORAGE_KEY = "reclipServerUrl";
const JOBS_KEY = "reclipJobs";

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

function persistJobPatch(jobId, patch) {
  if (!jobId) return Promise.resolve();
  return new Promise((resolve) => {
    chrome.storage.local.get(JOBS_KEY, (r) => {
      const map = migrateJobsMap(r[JOBS_KEY] || {});
      const prev = map[jobId] || {};
      map[jobId] = { ...prev, ...patch, jobId, updatedAt: Date.now() };
      chrome.storage.local.set({ [JOBS_KEY]: map }, resolve);
    });
  });
}

function getJobEntryByJobId(jobId) {
  return new Promise((resolve) => {
    if (!jobId) {
      resolve(null);
      return;
    }
    chrome.storage.local.get(JOBS_KEY, (r) => {
      const map = migrateJobsMap(r[JOBS_KEY] || {});
      resolve(map[jobId] || null);
    });
  });
}

function removeJobFromStorage(jobId) {
  return new Promise((resolve) => {
    chrome.storage.local.get(JOBS_KEY, (r) => {
      const map = migrateJobsMap(r[JOBS_KEY] || {});
      delete map[jobId];
      chrome.storage.local.set({ [JOBS_KEY]: map }, resolve);
    });
  });
}

/** Prefer newest active download for this tab, else most recent job. */
function pickPrimaryJobForTab(map, tabId) {
  const tid = String(tabId);
  const list = Object.entries(map).filter(([, j]) => String(j.tabId) === tid);
  const downloading = list.filter(([, j]) => j.status === "downloading");
  if (downloading.length) {
    downloading.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
    return { jobId: downloading[0][0], ...downloading[0][1] };
  }
  const sorted = list.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
  return sorted[0] ? { jobId: sorted[0][0], ...sorted[0][1] } : null;
}

/** @type {string | null} */
let currentPollingJobId = null;

let streamsExpanded = false;
let lastStreamCount = 0;
let lastInfo = null;
let selectedFormatId = null;
let currentTabId = null;
let currentPageUrl = "";
/** @type {ReturnType<typeof setInterval> | null} */
let statusPollInterval = null;

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

function showInfoCard(info, preferredFormatId) {
  const title = $("infoTitle");
  const meta = $("infoMeta");
  const fmts = $("infoFormats");
  const thumb = $("infoThumbWrap");
  const card = $("infoCard");
  if (!title || !meta || !fmts || !thumb || !card) return;

  lastInfo = info;
  if (preferredFormatId != null && preferredFormatId !== "") {
    selectedFormatId = preferredFormatId;
  } else {
    selectedFormatId = info.formats?.[0]?.id || null;
  }

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
        persistPageInfo();
      });
    });
  } else {
    fmts.innerHTML = "";
  }
}

function persistPageInfo() {
  if (!currentTabId || !currentPageUrl || !lastInfo) return;
  const PAGE_INFO_KEY = "reclipPageInfo";
  chrome.storage.local.get(PAGE_INFO_KEY, (r) => {
    const map = r[PAGE_INFO_KEY] || {};
    map[String(currentTabId)] = {
      pageUrl: currentPageUrl,
      info: lastInfo,
      selectedFormatId: selectedFormatId || null,
    };
    chrome.storage.local.set({ [PAGE_INFO_KEY]: map });
  });
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
    persistPageInfo();
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

    const jobSnapshot = {
      jobId,
      serverUrl,
      url: targetUrl,
      title: body.title,
      thumbnail: body.thumbnail,
      status: "downloading",
      progress: 0,
      progress_text: "",
      filename: null,
      error: null,
      savedToDevice: false,
    };

    if (currentTabId != null) {
      chrome.storage.local.get(JOBS_KEY, (r) => {
        const map = migrateJobsMap(r[JOBS_KEY] || {});
        map[jobId] = { ...jobSnapshot, tabId: currentTabId, updatedAt: Date.now() };
        chrome.storage.local.set({ [JOBS_KEY]: map });
      });
    }

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
    const btnCancel = $("btnCancelDownload");
    if (btnCancel) btnCancel.classList.remove("hidden");
    startLocalPolling(serverUrl, jobId);
  } catch (e) {
    showStatus(e.message || String(e), "error", false);
    if (btnDl) btnDl.disabled = false;
    if (btnPaste) btnPaste.disabled = false;
    setDownloadUiBusy(false);
  }
}

function startLocalPolling(serverUrl, jobId) {
  if (statusPollInterval) {
    clearInterval(statusPollInterval);
    statusPollInterval = null;
  }
  currentPollingJobId = jobId;

  const pollOnce = async () => {
    try {
      const res = await fetch(`${serverUrl}/api/status/${jobId}`);
      const data = await res.json().catch(() => ({}));
      if (data.status === "done") {
        if (statusPollInterval) clearInterval(statusPollInterval);
        statusPollInterval = null;
        const entry = await getJobEntryByJobId(jobId);
        if (entry && entry.jobId === jobId && entry.savedToDevice) {
          showStatus(
            entry.filename ? `Finished: ${entry.filename}` : "Download finished.",
            "ok",
            false
          );
          finishDownloadUi();
          return;
        }
        showStatus("Saving to device\u2026", "", true);
        await triggerBrowserDownload(serverUrl, jobId, data.filename);
        await persistJobPatch(jobId, {
          status: "done",
          filename: data.filename,
          savedToDevice: true,
        });
        showStatus("Done.", "ok", false);
        finishDownloadUi();
      } else if (data.status === "error") {
        if (statusPollInterval) clearInterval(statusPollInterval);
        statusPollInterval = null;
        showStatus(data.error || "Download failed", "error", false);
        await persistJobPatch(jobId, {
          status: "error",
          error: data.error || "Download failed",
        });
        finishDownloadUi();
      } else if (data.status === "cancelled") {
        if (statusPollInterval) clearInterval(statusPollInterval);
        statusPollInterval = null;
        showStatus(data.error || "Cancelled", "error", false);
        await persistJobPatch(jobId, {
          status: "cancelled",
          error: data.error || "Cancelled",
        });
        finishDownloadUi();
      } else if (data.progress_text) {
        showStatus(`Downloading\u2026 ${data.progress_text}`, "", true);
      } else if (data.status === "downloading") {
        showStatus("Downloading\u2026", "", true);
      }
    } catch {
      if (statusPollInterval) clearInterval(statusPollInterval);
      statusPollInterval = null;
      showStatus("Lost connection to server", "error", false);
      finishDownloadUi();
    }
  };

  void pollOnce();
  statusPollInterval = setInterval(() => {
    void pollOnce();
  }, 1000);
}

function finishDownloadUi() {
  if (statusPollInterval) {
    clearInterval(statusPollInterval);
    statusPollInterval = null;
  }
  currentPollingJobId = null;
  const btnCancel = $("btnCancelDownload");
  if (btnCancel) btnCancel.classList.add("hidden");
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
// Jobs list & cancel
// ---------------------------------------------------------------------------

async function cancelDownloadForJob(jobId, serverUrl, tabIdForJob) {
  const base = normalizeBase(serverUrl);
  try {
    await fetch(`${base}/api/cancel/${jobId}`, { method: "POST" });
  } catch {
    /* server may already have stopped */
  }
  await persistJobPatch(jobId, { status: "cancelled", error: "Cancelled" });
  const tid = typeof tabIdForJob === "number" ? tabIdForJob : Number(tabIdForJob);
  if (!Number.isNaN(tid)) {
    chrome.runtime.sendMessage({ type: "RECLIP_STOP_POLLING_FOR_TAB", tabId: tid });
  }
  if (currentPollingJobId === jobId) {
    if (statusPollInterval) clearInterval(statusPollInterval);
    statusPollInterval = null;
    currentPollingJobId = null;
    showStatus("Cancelled.", "error", false);
    finishDownloadUi();
  }
  await renderJobsList();
}

async function cancelCurrentDownload() {
  if (!currentPollingJobId) return;
  const entry = await getJobEntryByJobId(currentPollingJobId);
  if (!entry || !entry.serverUrl) return;
  await cancelDownloadForJob(currentPollingJobId, entry.serverUrl, entry.tabId);
}

function jobStatusLabel(st) {
  if (st === "downloading") return "Downloading";
  if (st === "done") return "Done";
  if (st === "error") return "Error";
  if (st === "cancelled") return "Cancelled";
  return st || "?";
}

function showMainPanel(which) {
  const main = $("panel-main");
  const jobs = $("panel-jobs");
  const tabMain = $("tabMain");
  const tabJobs = $("tabJobs");
  if (!main || !jobs) return;
  if (which === "jobs") {
    main.classList.add("hidden");
    jobs.classList.remove("hidden");
    if (tabMain) {
      tabMain.classList.remove("active");
      tabMain.setAttribute("aria-selected", "false");
    }
    if (tabJobs) {
      tabJobs.classList.add("active");
      tabJobs.setAttribute("aria-selected", "true");
    }
    renderJobsList();
  } else {
    jobs.classList.add("hidden");
    main.classList.remove("hidden");
    if (tabJobs) {
      tabJobs.classList.remove("active");
      tabJobs.setAttribute("aria-selected", "false");
    }
    if (tabMain) {
      tabMain.classList.add("active");
      tabMain.setAttribute("aria-selected", "true");
    }
    refreshStreams();
  }
}

async function renderJobsList() {
  const container = $("jobsList");
  if (!container) return;
  const serverUrl = await getServerUrl();
  const r = await new Promise((resolve) => {
    chrome.storage.local.get(JOBS_KEY, resolve);
  });
  const map = migrateJobsMap(r[JOBS_KEY] || {});
  const entries = Object.entries(map).sort(
    (a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0)
  );
  if (!entries.length) {
    container.innerHTML = '<p class="hint">No jobs yet.</p>';
    return;
  }
  container.innerHTML = "";
  for (const [jid, j] of entries) {
    const row = document.createElement("div");
    row.className = "job-row";
    const title = j.title || j.url || jid;
    const shortId = jid.length > 10 ? `${jid.slice(0, 10)}\u2026` : jid;
    const prog =
      j.progress_text ||
      (typeof j.progress === "number" && j.progress > 0 ? `${Math.round(j.progress)}%` : "");
    const parts = [`${shortId}`, jobStatusLabel(j.status)];
    if (prog) parts.push(trunc(prog, 36));
    const metaLine = parts.join(" \u00b7 ");

    const actions = document.createElement("div");
    actions.className = "job-actions";

    if (j.status === "downloading") {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "small cancel-job-btn";
      b.textContent = "Cancel";
      b.dataset.jid = jid;
      actions.appendChild(b);
    }
    if (j.status === "done" && !j.savedToDevice && serverUrl) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "small save-job-btn";
      b.textContent = "Save";
      b.dataset.jid = jid;
      actions.appendChild(b);
    }
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "small secondary remove-job-btn";
    rm.textContent = "Remove";
    rm.dataset.jid = jid;
    actions.appendChild(rm);

    const main = document.createElement("div");
    main.className = "job-row-main";
    const tEl = document.createElement("div");
    tEl.className = "job-title";
    tEl.textContent = trunc(title, 52);
    const mEl = document.createElement("div");
    mEl.className = "job-meta";
    mEl.textContent = metaLine;
    main.appendChild(tEl);
    main.appendChild(mEl);

    row.appendChild(main);
    row.appendChild(actions);
    container.appendChild(row);
  }

  container.querySelectorAll(".cancel-job-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.jid;
      chrome.storage.local.get(JOBS_KEY, async (r) => {
        const m = migrateJobsMap(r[JOBS_KEY] || {});
        const j = m[id];
        if (!j || !j.serverUrl) return;
        await cancelDownloadForJob(id, j.serverUrl, j.tabId);
      });
    });
  });
  container.querySelectorAll(".remove-job-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await removeJobFromStorage(btn.dataset.jid);
      renderJobsList();
    });
  });
  container.querySelectorAll(".save-job-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.jid;
      const j = map[id];
      if (!j || !serverUrl) return;
      try {
        const st = await fetch(`${serverUrl}/api/status/${id}`);
        const d = await st.json().catch(() => ({}));
        if (d.status === "done" && d.filename) {
          await triggerBrowserDownload(serverUrl, id, d.filename);
          await persistJobPatch(id, { savedToDevice: true, filename: d.filename });
        }
      } catch {
        /* ignore */
      }
      renderJobsList();
    });
  });
}

// ---------------------------------------------------------------------------
// Init
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

async function refreshStreams() {
  const serverUrl = await getServerUrl();
  $("serverHint").textContent = serverUrl ? `Server: ${serverUrl}` : "";

  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.id) return;
    currentTabId = tab.id;
    currentPageUrl = tab.url || "";
    const tabKey = String(tab.id);

    const [streamsResp, storageData] = await Promise.all([
      new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "RECLIP_GET_STREAMS", tabId: tab.id }, resolve);
      }),
      new Promise((resolve) => {
        chrome.storage.local.get(["reclipJobs", "reclipPageInfo"], resolve);
      }),
    ]);

    const streams = (streamsResp && streamsResp.streams) || [];
    renderStreams(streams, currentPageUrl);
    const btnDl = $("btnDownloadPage");
    if (btnDl) {
      btnDl.onclick = () => runDownload(pickDownloadUrl(streams, currentPageUrl));
    }

    const jobsMap = migrateJobsMap(storageData.reclipJobs || {});
    const infoMap = storageData.reclipPageInfo || {};
    const job = pickPrimaryJobForTab(jobsMap, tab.id);
    const cached = infoMap[tabKey] || null;
    const pageInfo = cached && cached.info && samePageUrl(cached.pageUrl, currentPageUrl)
      ? cached
      : null;

    if (pageInfo) {
      showInfoCard(pageInfo.info, pageInfo.selectedFormatId);
    }

    if (job && job.status === "downloading") {
      let resumePolling = true;
      try {
        const st = await fetch(`${job.serverUrl}/api/status/${job.jobId}`);
        const sd = await st.json().catch(() => ({}));
        if (sd.status === "done") {
          resumePolling = false;
          if (job.savedToDevice) {
            showStatus(
              job.filename ? `Finished: ${job.filename}` : "Download finished.",
              "ok",
              false
            );
          } else {
            showStatus("Saving to device\u2026", "", true);
            if (btnDl) btnDl.disabled = true;
            const btnPaste = $("btnPasteSend");
            if (btnPaste) btnPaste.disabled = true;
            setDownloadUiBusy(true);
            await triggerBrowserDownload(job.serverUrl, job.jobId, sd.filename);
            await persistJobPatch(job.jobId, {
              status: "done",
              filename: sd.filename,
              savedToDevice: true,
            });
            showStatus("Done.", "ok", false);
            if (btnDl) btnDl.disabled = false;
            if (btnPaste) btnPaste.disabled = false;
            setDownloadUiBusy(false);
          }
        } else if (sd.status === "cancelled") {
          resumePolling = false;
          showStatus(sd.error || "Cancelled.", "error", false);
          await persistJobPatch(job.jobId, {
            status: "cancelled",
            error: sd.error || "Cancelled",
          });
        }
      } catch {
        /* ignore; fall back to polling */
      }

      if (resumePolling) {
        let statusLine = "Downloading\u2026";
        if (job.progress_text) {
          statusLine = `Downloading\u2026 ${job.progress_text}`;
        } else if (typeof job.progress === "number" && !Number.isNaN(job.progress) && job.progress > 0) {
          statusLine = `Downloading\u2026 ${Math.round(job.progress)}%`;
        }
        showStatus(statusLine, "", true);
        if (btnDl) btnDl.disabled = true;
        const btnPaste = $("btnPasteSend");
        if (btnPaste) btnPaste.disabled = true;
        setDownloadUiBusy(true);
        const btnCancel = $("btnCancelDownload");
        if (btnCancel) btnCancel.classList.remove("hidden");
        startLocalPolling(job.serverUrl, job.jobId);
        chrome.runtime.sendMessage({ type: "RECLIP_ENSURE_POLLING", tabId: tab.id });
      }
    } else if (job && job.status === "done") {
      showStatus(job.filename ? `Finished: ${job.filename}` : "Download finished.", "ok", false);
    } else if (job && job.status === "error") {
      showStatus(job.error || "Download failed", "error", false);
    } else if (job && job.status === "cancelled") {
      showStatus(job.error || "Cancelled.", "error", false);
    }

    const skipInfoFetch = (job && job.status === "downloading") || pageInfo;
    if (!skipInfoFetch && serverUrl && currentPageUrl.startsWith("http")) {
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

  const tabMainEl = $("tabMain");
  if (tabMainEl) tabMainEl.addEventListener("click", () => showMainPanel("main"));
  const tabJobsEl = $("tabJobs");
  if (tabJobsEl) tabJobsEl.addEventListener("click", () => showMainPanel("jobs"));
  const btnCancelDl = $("btnCancelDownload");
  if (btnCancelDl) btnCancelDl.addEventListener("click", () => cancelCurrentDownload());
  const btnRefJobs = $("btnRefreshJobs");
  if (btnRefJobs) btnRefJobs.addEventListener("click", () => renderJobsList());

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
