/**
 * Detect video-related URLs in the page DOM and report to the background script.
 */
(function () {
  const seen = new Set();

  function canonicalEmbedUrl(iframe) {
    const src = iframe.getAttribute("src") || "";
    if (!src) return null;
    try {
      const u = new URL(src, location.href);
      const h = u.hostname;
      if (h.includes("youtube.com") || h.includes("youtube-nocookie.com")) {
        const embed = u.pathname.match(/\/embed\/([^/?]+)/);
        if (embed && embed[1]) return `https://www.youtube.com/watch?v=${embed[1]}`;
        const id = u.searchParams.get("v") || u.pathname.replace(/^\/shorts\//, "").split("/").pop();
        if (id && id.length >= 5) return `https://www.youtube.com/watch?v=${id}`;
      }
      if (h.includes("youtu.be")) {
        const id = u.pathname.replace(/^\//, "");
        if (id) return `https://www.youtube.com/watch?v=${id}`;
      }
      if (h.includes("vimeo.com")) {
        const m = u.pathname.match(/\/(\d+)/);
        if (m) return `https://vimeo.com/${m[1]}`;
      }
    } catch (_) {}
    return src.startsWith("http") ? src : new URL(src, location.href).href;
  }

  function collect() {
    const urls = [];

    // Page URL is always a candidate for yt-dlp
    urls.push({ kind: "page", url: location.href, label: "Page" });

    document.querySelectorAll("video").forEach((v) => {
      if (v.src) urls.push({ kind: "video", url: v.src, label: "Video" });
      if (v.currentSrc) urls.push({ kind: "video", url: v.currentSrc, label: "Video" });
    });

    document.querySelectorAll("video source").forEach((s) => {
      const u = s.getAttribute("src");
      if (u) {
        const abs = u.startsWith("http") ? u : new URL(u, location.href).href;
        urls.push({ kind: "source", url: abs, label: "Source" });
      }
    });

    document.querySelectorAll('iframe[src*="youtube"], iframe[src*="youtu.be"], iframe[src*="vimeo"]').forEach((f) => {
      const c = canonicalEmbedUrl(f);
      if (c) urls.push({ kind: "embed", url: c, label: "Embed" });
    });

    const key = JSON.stringify(urls.map((x) => x.url).sort());
    if (key === seen.lastKey) return;
    seen.lastKey = key;

    try {
      chrome.runtime.sendMessage({ type: "RECLIP_DOM_URLS", urls, pageUrl: location.href });
    } catch (_) {}
  }

  collect();
  const obs = new MutationObserver(() => {
    collect();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });

  window.addEventListener("load", collect);
})();
