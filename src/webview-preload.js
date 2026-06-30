const { ipcRenderer } = require("electron");

const MEDIA_PATTERN = /\.(m3u8|mpd|mp4|m4v|webm|mov|mkv|avi|ogv)(\?|#|$)/i;
const MEDIA_URL_PATTERN = /https?:\\?\/\\?\/[^\s"'<>\\]+?\.(?:m3u8|mpd|mp4|m4v|webm|mov|mkv|avi|ogv)(?:[^\s"'<>\\]*)?/gi;
const MASTER_LINK_PATTERN = /(?:https?:\\?\/\\?\/[^\s"'<>\\]+)?\\?\/player\\?\/master\\?\/[A-Za-z0-9_/-]+/gi;
const SUBTITLE_PATTERN = /\.(vtt|webvtt|srt|ttml|dfxp)(\?|#|$)/i;
const SUBTITLE_URL_PATTERN = /https?:\\?\/\\?\/[^\s"'<>\\]+?\.(?:vtt|webvtt|srt|ttml|dfxp)(?:[^\s"'<>\\]*)?/gi;
const sentCandidates = new Map();
const sentSubtitles = new Map();

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

function subtitleFormatForUrl(url) {
  const clean = url.split("?")[0].split("#")[0].toLowerCase();
  if (clean.endsWith(".vtt") || clean.endsWith(".webvtt")) return "webvtt";
  if (clean.endsWith(".ttml") || clean.endsWith(".dfxp")) return "ttml";
  if (clean.endsWith(".srt")) return "srt";
  return "";
}

function subtitleContentTypeForUrl(url) {
  const format = subtitleFormatForUrl(url);
  if (format === "ttml") return "application/ttml+xml";
  if (format === "srt") return "application/x-subrip";
  return "text/vtt";
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

function isSubtitleUrl(url) {
  return !isLikelyAdMediaUrl(url) && SUBTITLE_PATTERN.test(url);
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
    subtitles: Array.isArray(details.subtitles) ? details.subtitles : [],
    score,
    seenAt: Date.now()
  });
}

function sendSubtitle(url, source, details = {}) {
  const normalized = absoluteUrl(url);
  if (!normalized || !isSubtitleUrl(normalized)) return;

  const format = subtitleFormatForUrl(normalized);
  const score = details.score ?? (source === "DOM" ? 80 : source === "Page data" ? 62 : 48);
  const previousScore = sentSubtitles.get(normalized) || 0;
  if (previousScore >= score) return;
  sentSubtitles.set(normalized, score);

  ipcRenderer.sendToHost("subtitle-candidate", {
    url: normalized,
    contentType: subtitleContentTypeForUrl(normalized),
    source,
    pageUrl: window.location.href,
    label: details.label || "",
    language: details.language || "",
    kind: details.kind || "subtitles",
    format,
    isDefault: Boolean(details.isDefault),
    castSupported: true,
    requiresConversion: format === "srt",
    unsupportedReason: "",
    score,
    seenAt: Date.now()
  });
}

function trackInfo(track) {
  const normalized = absoluteUrl(track.src || track.getAttribute("src"));
  if (!normalized || !isSubtitleUrl(normalized)) return null;
  return {
    url: normalized,
    contentType: subtitleContentTypeForUrl(normalized),
    source: "DOM",
    pageUrl: window.location.href,
    label: track.label || track.getAttribute("label") || "",
    language: track.srclang || track.getAttribute("srclang") || "",
    kind: track.kind || track.getAttribute("kind") || "subtitles",
    format: subtitleFormatForUrl(normalized),
    isDefault: Boolean(track.default),
    castSupported: true,
    requiresConversion: subtitleFormatForUrl(normalized) === "srt",
    unsupportedReason: "",
    score: track.default ? 88 : 80,
    seenAt: Date.now()
  };
}

function inspectTrackElement(track) {
  const subtitle = trackInfo(track);
  if (!subtitle) return null;
  sendSubtitle(subtitle.url, "DOM", subtitle);
  return subtitle;
}

function inspectVideoElement(video) {
  const subtitles = Array.from(video.querySelectorAll("track[src]")).map(inspectTrackElement).filter(Boolean);
  sendCandidate(video.currentSrc, "DOM", video, { subtitles });
  sendCandidate(video.src, "DOM", video, { subtitles });
  video.querySelectorAll("source[src]").forEach((source) => {
    sendCandidate(source.src, "DOM", video, { subtitles });
  });
}

function scanDom() {
  document.querySelectorAll("video").forEach(inspectVideoElement);
  document.querySelectorAll("track[src]").forEach(inspectTrackElement);
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
  scanLooseSubtitleUrls(scriptText);
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

function scanLooseSubtitleUrls(rawText) {
  const text = decodeJsonish(rawText);
  SUBTITLE_URL_PATTERN.lastIndex = 0;
  let count = 0;
  let match;
  while ((match = SUBTITLE_URL_PATTERN.exec(text)) && count < 40) {
    sendSubtitle(match[0], "Page data", {
      score: 62
    });
    count += 1;
  }
}

function patchNetworkApis() {
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function patchedFetch(input, init) {
      const requestUrl = typeof input === "string" ? input : input?.url;
      sendCandidate(requestUrl, "Fetch", null);
      sendSubtitle(requestUrl, "Fetch");
      return originalFetch.call(this, input, init);
    };
  }

  const originalOpen = window.XMLHttpRequest?.prototype?.open;
  if (originalOpen) {
    window.XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
      sendCandidate(url, "XHR", null);
      sendSubtitle(url, "XHR");
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
    attributeFilter: ["src", "href", "label", "srclang"]
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
