const { ipcRenderer } = require("electron");

const MEDIA_PATTERN = /\.(m3u8|mpd|mp4|m4v|webm|mov|mkv|avi|ogv)(\?|#|$)/i;
const MEDIA_URL_PATTERN = /https?:\\?\/\\?\/[^\s"'<>\\]+?\.(?:m3u8|mpd|mp4|m4v|webm|mov|mkv|avi|ogv)(?:[^\s"'<>\\]*)?/gi;
const MASTER_LINK_PATTERN = /(?:https?:\\?\/\\?\/[^\s"'<>\\]+)?\\?\/player\\?\/master\\?\/[A-Za-z0-9_/-]+/gi;
const sentCandidates = new Map();

function decodeJsonish(value) {
  return String(value || "")
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/[),.;]+$/g, "");
}

function absoluteUrl(value) {
  const cleaned = decodeJsonish(value);
  if (!cleaned || cleaned.startsWith("blob:")) return null;

  try {
    const parsed = new URL(cleaned, window.location.href);
    const nestedMedia = parsed.searchParams.get("url");
    if (nestedMedia && (MEDIA_PATTERN.test(nestedMedia) || nestedMedia.includes("/player/master/"))) {
      return new URL(nestedMedia, window.location.href).toString();
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function contentTypeForUrl(url) {
  const clean = url.split("?")[0].toLowerCase();
  if (clean.endsWith(".m3u8")) return "application/x-mpegURL";
  if (clean.endsWith(".mpd")) return "application/dash+xml";
  if (clean.includes("/player/master/")) return "application/x-mpegURL";
  if (clean.endsWith(".mp4") || clean.endsWith(".m4v")) return "video/mp4";
  if (clean.endsWith(".webm")) return "video/webm";
  if (clean.endsWith(".mov")) return "video/quicktime";
  if (clean.endsWith(".ogv")) return "video/ogg";
  return "video/mp4";
}

function isLikelyAdMediaUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    return (
      host.includes("adcenter") ||
      /(^|[.-])ads?([.-]|$)/i.test(host) ||
      /\/(ads?|adserver|banner|banners|popup|promos?)\//i.test(pathname)
    );
  } catch {
    return false;
  }
}

function isSupportedMediaUrl(url) {
  const clean = url.split("?")[0].toLowerCase();
  return !isLikelyAdMediaUrl(url) && (MEDIA_PATTERN.test(url) || clean.includes("/player/master/"));
}

function defaultScoreFor(source, element) {
  if (element && !element.paused) return 90;
  if (source === "DOM") return 65;
  if (source === "Page data") return 48;
  return 35;
}

function currentEpisodeNumber() {
  const match = window.location.pathname.match(/(?:tap|episode|ep)-?(\d+)/i);
  return match ? Number(match[1]) : null;
}

function episodeNumberFromName(name) {
  const match = String(name || "").match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

function sendCandidate(url, source, element, details = {}) {
  const normalized = absoluteUrl(url);
  if (!normalized || !isSupportedMediaUrl(normalized)) return;

  const score = details.score ?? defaultScoreFor(source, element);
  const previousScore = sentCandidates.get(normalized) || 0;
  if (previousScore >= score) return;
  sentCandidates.set(normalized, score);

  ipcRenderer.sendToHost("media-candidate", {
    url: normalized,
    contentType: contentTypeForUrl(normalized),
    source,
    title: details.title || document.title || "",
    candidateKind: details.candidateKind || "unknown",
    server: details.server || "",
    episodeName: details.episodeName || "",
    confidence: details.confidence || "",
    reason: details.reason || "",
    pageUrl: window.location.href,
    poster: element?.poster || "",
    score,
    seenAt: Date.now()
  });
}

function inspectVideoElement(video) {
  sendCandidate(video.currentSrc, "DOM", video);
  sendCandidate(video.src, "DOM", video);
  video.querySelectorAll("source[src]").forEach((source) => {
    sendCandidate(source.src, "DOM", video);
  });
}

function scanDom() {
  document.querySelectorAll("video").forEach(inspectVideoElement);
  document.querySelectorAll("a[href], source[src]").forEach((element) => {
    sendCandidate(element.href || element.src, "DOM", null);
  });
  scanPageData();
}

function scanPageData() {
  const scriptText = Array.from(document.scripts)
    .map((script) => script.textContent || "")
    .filter(Boolean)
    .join("\n");

  if (!scriptText) return;

  scanStructuredEpisodes(scriptText);
  scanLooseMediaUrls(scriptText);
}

function scanStructuredEpisodes(rawText) {
  const text = decodeJsonish(rawText);
  const currentEpisode = currentEpisodeNumber();
  const titleText = (document.title || "").toLowerCase();
  const wantsVietsub = titleText.includes("vietsub");
  const wantsDub = titleText.includes("lồng tiếng") || titleText.includes("long tieng") || titleText.includes("thuyết minh") || titleText.includes("thuyet minh");
  const episodePattern = /"server":"([^"]+)"[\s\S]{0,260}?"name":"([^"]+)"[\s\S]{0,260}?"type":"([^"]+)"[\s\S]{0,260}?"link":"([^"]+)"/g;
  let match;
  let count = 0;

  while ((match = episodePattern.exec(text)) && count < 24) {
    const server = match[1];
    const name = match[2];
    const type = match[3];
    const link = match[4];
    const episodeNumber = episodeNumberFromName(name);
    const matchesCurrentEpisode = currentEpisode === null || episodeNumber === currentEpisode;

    if (!matchesCurrentEpisode || !/m3u8|embed/i.test(type)) {
      continue;
    }

    const serverText = server.toLowerCase();
    const languageScore =
      (wantsVietsub && serverText.includes("vietsub") ? 36 : 0) +
      (wantsVietsub && serverText.includes("lồng tiếng") ? -36 : 0) +
      (wantsDub && (serverText.includes("lồng tiếng") || serverText.includes("thuyết minh")) ? 36 : 0);
    const score = 120 + (episodeNumber === currentEpisode ? 40 : 0) + (/m3u8/i.test(type) ? 12 : 0) + languageScore;
    sendCandidate(link, "Page data", null, {
      title: `${document.title || "Video"} - ${server} - ${name}`,
      candidateKind: "episode",
      server,
      episodeName: name,
      confidence: "high",
      reason: "Từ dữ liệu tập hiện tại",
      score
    });
    count += 1;
  }
}

function scanLooseMediaUrls(rawText) {
  const text = decodeJsonish(rawText);
  const patterns = [MEDIA_URL_PATTERN, MASTER_LINK_PATTERN];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let count = 0;
    let match;
    while ((match = pattern.exec(text)) && count < 30) {
      sendCandidate(match[0], "Page data", null, {
        candidateKind: "loose",
        confidence: "low",
        reason: "Tìm thấy trong script",
        score: 52
      });
      count += 1;
    }
  }
}

function patchNetworkApis() {
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function patchedFetch(input, init) {
      const requestUrl = typeof input === "string" ? input : input?.url;
      sendCandidate(requestUrl, "Fetch", null);
      return originalFetch.call(this, input, init);
    };
  }

  const originalOpen = window.XMLHttpRequest?.prototype?.open;
  if (originalOpen) {
    window.XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
      sendCandidate(url, "XHR", null);
      return originalOpen.call(this, method, url, ...rest);
    };
  }
}

function installListeners() {
  document.addEventListener("play", (event) => {
    if (event.target?.tagName === "VIDEO") {
      inspectVideoElement(event.target);
    }
  }, true);

  document.addEventListener("loadedmetadata", (event) => {
    if (event.target?.tagName === "VIDEO") {
      inspectVideoElement(event.target);
    }
  }, true);

  const observer = new MutationObserver(() => scanDom());
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "href"]
  });
}

patchNetworkApis();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    scanDom();
    installListeners();
  });
} else {
  scanDom();
  installListeners();
}

setInterval(scanDom, 3000);
