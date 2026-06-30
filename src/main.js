const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const os = require("os");
const { app, BrowserWindow, ipcMain, session, shell } = require("electron");
const { Bonjour } = require("bonjour-service");
const { DefaultMediaApp, PersistentClient, ReceiverController, Result } = require("@foxxmd/chromecast-client");

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MEDIA_EXTENSIONS = [
  ".m3u8",
  ".mpd",
  ".mp4",
  ".m4v",
  ".webm",
  ".mov",
  ".mkv",
  ".avi",
  ".ogv"
];
const SUBTITLE_EXTENSIONS = [
  ".vtt",
  ".webvtt",
  ".srt",
  ".ttml",
  ".dfxp"
];
const APP_STATE_FILE = "movie-cast-browser-state.json";
const HISTORY_LIMIT = 40;
const PLAYBACK_POSITION_LIMIT = 100;
const MEDIA_COMMANDS = {
  pause: 1,
  seek: 2,
  streamVolume: 4,
  streamMute: 8,
  skipForward: 16,
  skipBackward: 32
};

let mainWindow;
let bonjour;
let bonjourBrowser;
let castDevices = new Map();
let currentDeviceId = null;
let currentCast = null;
let lastPageUrl = "";
let subtitleServer = null;
let subtitleServerBaseUrl = "";
let subtitleServerPromise = null;
const preparedSubtitles = new Map();
const probedHlsManifests = new Set();

function stateFilePath() {
  return path.join(app.getPath("userData"), APP_STATE_FILE);
}

function emptyAppState() {
  return {
    lastPageUrl: "",
    history: [],
    playbackPositions: [],
    appMuted: false
  };
}

function readAppState() {
  try {
    const raw = fs.readFileSync(stateFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    return {
      lastPageUrl: typeof parsed.lastPageUrl === "string" ? parsed.lastPageUrl : "",
      history: Array.isArray(parsed.history) ? parsed.history.filter((item) => isHistoryUrl(item.url)).slice(0, HISTORY_LIMIT) : [],
      playbackPositions: Array.isArray(parsed.playbackPositions)
        ? parsed.playbackPositions.filter((item) => isHistoryUrl(item.url)).slice(0, PLAYBACK_POSITION_LIMIT)
        : [],
      appMuted: Boolean(parsed.appMuted)
    };
  } catch {
    return emptyAppState();
  }
}

function writeAppState(state) {
  const nextState = {
    lastPageUrl: state.lastPageUrl || "",
    history: Array.isArray(state.history) ? state.history.slice(0, HISTORY_LIMIT) : [],
    playbackPositions: Array.isArray(state.playbackPositions) ? state.playbackPositions.slice(0, PLAYBACK_POSITION_LIMIT) : [],
    appMuted: Boolean(state.appMuted)
  };
  fs.mkdirSync(path.dirname(stateFilePath()), { recursive: true });
  fs.writeFileSync(stateFilePath(), JSON.stringify(nextState, null, 2));
  return nextState;
}

function isHistoryUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function updatePageHistory(payload) {
  const url = payload?.url || "";
  if (!isHistoryUrl(url)) {
    return readAppState();
  }

  if (url !== lastPageUrl) {
    probedHlsManifests.clear();
  }
  lastPageUrl = url;
  const currentState = readAppState();
  const title = String(payload?.title || "").trim();
  const existing = currentState.history.find((item) => item.url === url);
  const entry = {
    url,
    title: title || existing?.title || hostForDisplay(url),
    visitedAt: Date.now()
  };
  const history = [
    entry,
    ...currentState.history.filter((item) => item.url !== url)
  ].slice(0, HISTORY_LIMIT);

  const nextState = writeAppState({
    lastPageUrl: url,
    history,
    playbackPositions: currentState.playbackPositions,
    appMuted: currentState.appMuted
  });
  sendHistory(nextState.history);
  return nextState;
}

function clearPageHistory() {
  const currentState = readAppState();
  const nextState = writeAppState({
    ...emptyAppState(),
    appMuted: currentState.appMuted
  });
  lastPageUrl = "";
  sendHistory(nextState.history);
  return nextState;
}

function updateAppMuted(muted) {
  const currentState = readAppState();
  const nextState = writeAppState({
    ...currentState,
    appMuted: Boolean(muted)
  });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("app-muted-updated", nextState.appMuted);
  }
  return nextState.appMuted;
}

function sendHistory(history) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("history-updated", history);
}

function hostForDisplay(rawUrl) {
  try {
    return new URL(rawUrl).host;
  } catch {
    return rawUrl;
  }
}

function playbackPositionFor(url) {
  if (!url) return null;
  const appState = readAppState();
  return appState.playbackPositions.find((item) => item.url === url) || null;
}

function resumeTimeFor(url) {
  const position = playbackPositionFor(url);
  if (!position) return 0;
  const currentTime = Number(position.currentTime || 0);
  const duration = Number(position.duration || 0);
  if (currentTime < 5) return 0;
  if (duration > 0 && currentTime > duration - 20) return 0;
  return currentTime;
}

function rememberPlaybackPosition(playback = getCachedPlaybackStatus()) {
  if (!playback?.mediaUrl || !isHistoryUrl(playback.mediaUrl)) return;
  const currentTime = Number(playback.currentTime || 0);
  if (currentTime < 5) return;

  const appState = readAppState();
  const entry = {
    url: playback.mediaUrl,
    title: playback.title || hostForDisplay(playback.mediaUrl),
    currentTime,
    duration: Number(playback.duration || 0),
    updatedAt: Date.now()
  };
  const playbackPositions = [
    entry,
    ...appState.playbackPositions.filter((item) => item.url !== playback.mediaUrl)
  ].slice(0, PLAYBACK_POSITION_LIMIT);

  writeAppState({
    ...appState,
    playbackPositions
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    title: "Movie Cast Browser",
    backgroundColor: "#101317",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  attachMediaRequestDetector();
  maybeRunSmokeCapture();

  mainWindow.on("closed", () => {
    mainWindow = null;
    stopDiscovery();
    stopSubtitleServer();
  });
}

function stopSubtitleServer() {
  if (subtitleServer) {
    subtitleServer.close();
  }
  subtitleServer = null;
  subtitleServerBaseUrl = "";
  subtitleServerPromise = null;
  preparedSubtitles.clear();
}

function maybeRunSmokeCapture() {
  if (process.env.MOVIE_CAST_BROWSER_SMOKE !== "1") return;

  const outputDir = path.resolve(process.env.SMOKE_OUTPUT_DIR || path.join(__dirname, "..", "smoke-output"));
  const waitMs = Number(process.env.SMOKE_WAIT_MS || 11000);
  setTimeout(async () => {
    try {
      const result = await mainWindow.webContents.executeJavaScript(`({
        candidateCount: document.querySelectorAll(".candidate-row").length,
        url: document.getElementById("urlInput")?.value || "",
        webviewUrl: document.getElementById("movieWebview")?.getURL?.() || "",
        webviewTitle: document.getElementById("movieWebview")?.getTitle?.() || "",
        statusText: document.getElementById("statusText")?.textContent || "",
        castState: document.getElementById("castState")?.textContent || ""
      })`);
      const image = await mainWindow.webContents.capturePage();

      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, "screenshot.png"), image.toPNG());
      fs.writeFileSync(path.join(outputDir, "smoke.json"), JSON.stringify({
        ...result,
        passed: result.candidateCount > 0,
        capturedAt: new Date().toISOString()
      }, null, 2));

      if (result.candidateCount < 1) {
        process.exitCode = 1;
      }
    } catch (error) {
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, "smoke-error.txt"), error.stack || error.message);
      process.exitCode = 1;
    } finally {
      app.quit();
    }
  }, waitMs);
}

function attachMediaRequestDetector() {
  const castSession = session.fromPartition("persist:movie-cast-browser");
  castSession.webRequest.onBeforeRequest((details, callback) => {
    const media = normalizeMediaUrl(details.url);
    if (media && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("media-candidate", {
        url: media.url,
        contentType: media.contentType,
        source: "Network",
        pageUrl: lastPageUrl,
        score: scoreUrl(media.url, "Network"),
        seenAt: Date.now()
      });
      probeHlsSubtitles(media.url);
    }
    const subtitle = normalizeSubtitleUrl(details.url, "Network");
    if (subtitle && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("subtitle-candidate", {
        ...subtitle,
        pageUrl: lastPageUrl,
        seenAt: Date.now()
      });
    }
    callback({});
  });
}

function normalizeMediaUrl(rawUrl) {
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (isLikelyAdMediaUrl(parsed)) {
    return null;
  }

  const pathname = parsed.pathname.toLowerCase();
  const extension = MEDIA_EXTENSIONS.find((item) => pathname.endsWith(item));
  if (!extension) {
    return null;
  }

  if (extension === ".ts" || extension === ".m4s") {
    return null;
  }

  return {
    url: parsed.toString(),
    contentType: contentTypeForUrl(parsed.toString())
  };
}

function normalizeSubtitleUrl(rawUrl, source = "Network") {
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (isLikelyAdMediaUrl(parsed)) {
    return null;
  }

  const pathname = parsed.pathname.toLowerCase();
  const extension = SUBTITLE_EXTENSIONS.find((item) => pathname.endsWith(item));
  if (!extension) {
    return null;
  }

  const format = subtitleFormatForUrl(parsed.toString());
  return {
    url: parsed.toString(),
    contentType: subtitleContentTypeForUrl(parsed.toString()),
    source,
    label: "",
    language: "",
    kind: "subtitles",
    format,
    isDefault: false,
    castSupported: true,
    requiresConversion: format === "srt",
    unsupportedReason: "",
    score: source === "Network" ? 50 : 48
  };
}

function isLikelyAdMediaUrl(parsedUrl) {
  const host = parsedUrl.hostname.toLowerCase();
  const pathname = parsedUrl.pathname.toLowerCase();
  return (
    host.includes("adcenter") ||
    /(^|[.-])ads?([.-]|$)/i.test(host) ||
    /\/(ads?|adserver|banner|banners|popup|promos?)\//i.test(pathname)
  );
}

function contentTypeForUrl(url) {
  const clean = url.split("?")[0].toLowerCase();
  if (clean.endsWith(".m3u8")) return "application/x-mpegURL";
  if (clean.endsWith(".mpd")) return "application/dash+xml";
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

function parseHlsAttributes(line) {
  const attrs = {};
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let match;
  while ((match = pattern.exec(line))) {
    attrs[match[1].toUpperCase()] = String(match[2] || "").replace(/^"|"$/g, "");
  }
  return attrs;
}

function hlsSubtitleCandidates(manifestText, manifestUrl) {
  return String(manifestText || "")
    .split(/\r?\n/)
    .filter((line) => /^#EXT-X-MEDIA/i.test(line) && /TYPE=SUBTITLES/i.test(line))
    .slice(0, 24)
    .map((line) => {
      const attrs = parseHlsAttributes(line);
      if (!attrs.URI) return null;
      let url;
      try {
        url = new URL(attrs.URI, manifestUrl).toString();
      } catch {
        return null;
      }
      const format = subtitleFormatForUrl(url) || (url.split("?")[0].toLowerCase().endsWith(".m3u8") ? "hls-vtt" : "");
      if (!format) return null;
      return {
        url,
        contentType: format === "hls-vtt" ? "application/x-mpegURL" : subtitleContentTypeForUrl(url),
        source: "HLS",
        pageUrl: lastPageUrl,
        label: attrs.NAME || "",
        language: attrs.LANGUAGE || "",
        kind: "subtitles",
        format,
        isDefault: /^YES$/i.test(attrs.DEFAULT || ""),
        castSupported: true,
        requiresConversion: format === "srt",
        unsupportedReason: "",
        score: 78,
        seenAt: Date.now()
      };
    })
    .filter(Boolean);
}

async function probeHlsSubtitles(url) {
  if (!url || !url.toLowerCase().includes(".m3u8") || probedHlsManifests.has(url)) return;
  probedHlsManifests.add(url);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": DEFAULT_USER_AGENT
      }
    });
    if (!response.ok) return;
    const text = (await response.text()).slice(0, 300000);
    const subtitles = hlsSubtitleCandidates(text, url);
    for (const subtitle of subtitles) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("subtitle-candidate", subtitle);
      }
    }
  } catch {
    // HLS manifests often require page cookies or private headers; skip them.
  }
}

function scoreUrl(url, source) {
  const clean = url.split("?")[0].toLowerCase();
  let score = source === "DOM" ? 40 : 25;
  if (clean.endsWith(".m3u8") || clean.endsWith(".mpd")) score += 35;
  if (clean.endsWith(".mp4") || clean.endsWith(".webm") || clean.endsWith(".m4v")) score += 30;
  if (url.includes("blob:")) score -= 100;
  return score;
}

function startDiscovery() {
  if (bonjourBrowser) {
    sendDevices();
    return;
  }

  castDevices = new Map();
  bonjour = new Bonjour();
  bonjourBrowser = bonjour.find({ type: "googlecast" });

  bonjourBrowser.on("up", (service) => {
    const host = service.addresses?.find((address) => /^\d+\.\d+\.\d+\.\d+$/.test(address)) || service.host;
    const id = service.fqdn || service.name || host;
    if (!id) return;
    castDevices.set(id, {
      id,
      name: service.name || "Chromecast",
      host,
      port: service.port || 8009,
      raw: service
    });
    sendDevices();
  });

  bonjourBrowser.on("error", (error) => {
    sendCastStatus({
      state: "error",
      message: `Discovery error: ${error.message}`
    });
  });

  sendCastStatus({
    state: "discovering",
    message: "Scanning for Chromecast devices"
  });
}

function restartDiscovery() {
  stopDiscovery();
  sendDevices();
  startDiscovery();
}

function stopDiscovery() {
  if (bonjourBrowser && typeof bonjourBrowser.stop === "function") {
    bonjourBrowser.stop();
  }
  if (bonjour && typeof bonjour.destroy === "function") {
    bonjour.destroy();
  }
  bonjour = null;
  bonjourBrowser = null;
  castDevices = new Map();
}

function sendDevices() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const devices = Array.from(castDevices.values()).map((device) => ({
    id: device.id,
    name: device.name,
    host: device.host,
    selected: device.id === currentDeviceId
  }));
  mainWindow.webContents.send("cast-devices", devices);
}

function sendCastStatus(status) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("cast-status", {
    ...status,
    playback: getCachedPlaybackStatus(),
    at: Date.now()
  });
}

function subtitleDisplayName(subtitle) {
  if (!subtitle) return "";
  if (subtitle.label) return subtitle.requiresConversion ? `${subtitle.label} (convert)` : subtitle.label;
  if (subtitle.language) return subtitle.language.toUpperCase();
  if (subtitle.format === "srt") return "SRT (convert)";
  if (subtitle.format === "ttml") return "TTML";
  if (subtitle.format === "hls-vtt") return "HLS Sub";
  return "WebVTT";
}

function localLanAddress() {
  const interfaces = os.networkInterfaces();
  for (const values of Object.values(interfaces)) {
    for (const address of values || []) {
      if (address.family === "IPv4" && !address.internal && !address.address.startsWith("169.254.")) {
        return address.address;
      }
    }
  }
  return "";
}

async function ensureSubtitleServer() {
  if (subtitleServer && subtitleServerBaseUrl) {
    return subtitleServerBaseUrl;
  }
  if (subtitleServerPromise) {
    return subtitleServerPromise;
  }

  const address = localLanAddress();
  if (!address) {
    throw new Error("Không tìm thấy IP LAN của máy để TV tải phụ đề.");
  }

  subtitleServerPromise = new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const id = String(request.url || "").replace(/^\/subtitles\//, "").replace(/\.vtt(?:\?.*)?$/, "");
      const body = preparedSubtitles.get(id);
      if (!body) {
        response.writeHead(404, { "Content-Length": "0" });
        response.end();
        return;
      }
      const bytes = Buffer.from(body, "utf8");
      response.writeHead(200, {
        "Content-Type": "text/vtt; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Content-Length": bytes.length
      });
      response.end(bytes);
    });
    server.once("error", (error) => {
      if (subtitleServer === server) {
        subtitleServer = null;
        subtitleServerBaseUrl = "";
        subtitleServerPromise = null;
      }
      reject(error);
    });
    server.listen(0, "0.0.0.0", () => {
      subtitleServer = server;
      subtitleServer.unref();
      const port = server.address().port;
      subtitleServerBaseUrl = `http://${address}:${port}`;
      resolve(subtitleServerBaseUrl);
    });
  });
  return subtitleServerPromise;
}

function convertSrtToWebVtt(raw) {
  const blocks = String(raw || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n{2,}/);
  const cues = blocks.map((block) => {
    const lines = block.split("\n").map((line) => line.trimEnd()).filter(Boolean);
    if (!lines.length) return "";
    if (/^\d+$/.test(lines[0])) lines.shift();
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) return "";
    const timeLine = lines[timeIndex].replace(/,/g, ".");
    const text = lines.slice(timeIndex + 1).join("\n");
    return text ? `${timeLine}\n${text}` : "";
  }).filter(Boolean);

  if (!cues.length) {
    throw new Error("SRT không có cue hợp lệ để convert.");
  }
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

async function prepareSubtitleForCast(subtitle) {
  if (!subtitle?.url || subtitle.castSupported === false) return null;
  if (!subtitle.requiresConversion) {
    return {
      ...subtitle,
      castUrl: subtitle.url,
      castContentType: subtitle.contentType || subtitleContentTypeForUrl(subtitle.url),
      castLabel: subtitleDisplayName(subtitle)
    };
  }

  let response;
  try {
    response = await fetch(subtitle.url, {
      redirect: "follow",
      headers: {
        "User-Agent": DEFAULT_USER_AGENT
      }
    });
  } catch {
    throw new Error("Không tải được SRT công khai, có thể URL cần cookie hoặc header riêng.");
  }
  if (!response.ok) {
    throw new Error(`Không tải được SRT công khai, HTTP ${response.status}.`);
  }
  const length = Number(response.headers.get("content-length") || 0);
  if (length > 2 * 1024 * 1024) {
    throw new Error("File phụ đề quá lớn để convert nhanh.");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) {
    throw new Error("File phụ đề quá lớn để convert nhanh.");
  }

  const vtt = convertSrtToWebVtt(text);
  const id = crypto.createHash("sha256").update(vtt).digest("hex").slice(0, 24);
  preparedSubtitles.set(id, vtt);
  return {
    ...subtitle,
    castUrl: `${await ensureSubtitleServer()}/subtitles/${id}.vtt`,
    castContentType: "text/vtt",
    castLabel: subtitle.label || "SRT đã convert"
  };
}

async function prepareCandidateForCast(candidate) {
  const subtitles = Array.isArray(candidate.subtitles) ? candidate.subtitles.slice(0, 1) : [];
  const prepared = [];
  for (const subtitle of subtitles) {
    const result = await prepareSubtitleForCast(subtitle);
    if (result) prepared.push(result);
  }
  return {
    ...candidate,
    subtitles: prepared
  };
}

function activeTrackIdsFor(candidate) {
  return Array.isArray(candidate.subtitles) && candidate.subtitles.length ? [1] : [];
}

function toChromecastMedia(candidate) {
  const media = {
    contentId: candidate.url,
    contentType: candidate.contentType || contentTypeForUrl(candidate.url),
    streamType: "BUFFERED",
    metadata: {
      metadataType: 0,
      title: candidate.title || "Movie Cast Browser",
      images: candidate.poster ? [{ url: candidate.poster }] : []
    }
  };
  const tracks = (candidate.subtitles || []).map((subtitle, index) => ({
    trackId: index + 1,
    type: "TEXT",
    trackContentId: subtitle.castUrl || subtitle.url,
    trackContentType: subtitle.castContentType || subtitle.contentType || subtitleContentTypeForUrl(subtitle.url),
    name: subtitle.castLabel || subtitleDisplayName(subtitle),
    language: subtitle.language || "und",
    subtype: "SUBTITLES"
  }));
  if (tracks.length) {
    media.tracks = tracks;
  }
  return media;
}

function queueItemForCandidate(candidate) {
  return {
    url: candidate.url,
    title: candidate.title || "Movie Cast Browser",
    contentType: candidate.contentType || contentTypeForUrl(candidate.url),
    subtitle: candidate.subtitles?.[0]?.castLabel || candidate.subtitles?.[0]?.label || "",
    addedAt: Date.now()
  };
}

function supportedCommandsFor(mask) {
  const value = Number(mask || 0);
  return {
    pause: value > 0 ? Boolean(value & MEDIA_COMMANDS.pause) : true,
    seek: value > 0 ? Boolean(value & MEDIA_COMMANDS.seek) : true,
    streamVolume: value > 0 ? Boolean(value & MEDIA_COMMANDS.streamVolume) : true,
    streamMute: value > 0 ? Boolean(value & MEDIA_COMMANDS.streamMute) : true,
    skipForward: value > 0 ? Boolean(value & MEDIA_COMMANDS.skipForward) : true,
    skipBackward: value > 0 ? Boolean(value & MEDIA_COMMANDS.skipBackward) : true
  };
}

function mediaApplicationFromStatus(receiverStatus) {
  const applications = receiverStatus?.applications || [];
  return applications.find((application) => {
    return application.namespaces?.some((namespace) => namespace.name === "urn:x-cast:com.google.cast.media");
  }) || applications[0] || null;
}

function normalizePlaybackStatus(status, volume) {
  if (!status) {
    return getCachedPlaybackStatus();
  }

  const statusVolume = volume || status.volume || currentCast?.playback;
  const supportedMediaCommands = Number(status.supportedMediaCommands || 0);
  const activeApp = mediaApplicationFromStatus(currentCast?.receiverStatus);

  return {
    connected: true,
    playerState: status.playerState || "UNKNOWN",
    currentTime: Number(status.currentTime || 0),
    duration: Number(status.media?.duration || 0),
    title: status.media?.metadata?.title || "Movie Cast Browser",
    mediaUrl: status.media?.contentId || "",
    mediaSessionId: status.mediaSessionId || null,
    idleReason: status.idleReason || "",
    playbackRate: Number(status.playbackRate || 1),
    supportedMediaCommands,
    commands: supportedCommandsFor(supportedMediaCommands),
    deviceName: currentCast?.device?.name || "",
    activeAppName: activeApp?.displayName || "",
    activeAppId: activeApp?.appId || "",
    receiverStatusText: activeApp?.statusText || "",
    queue: currentCast?.queue || [],
    volumeLevel: typeof statusVolume?.level === "number" ? statusVolume.level : currentCast?.playback?.volumeLevel ?? null,
    muted: typeof statusVolume?.muted === "boolean" ? statusVolume.muted : currentCast?.playback?.muted ?? false
  };
}

function getCachedPlaybackStatus() {
  return currentCast?.playback || {
    connected: false,
    playerState: "IDLE",
    currentTime: 0,
    duration: 0,
    title: "",
    mediaUrl: "",
    mediaSessionId: null,
    idleReason: "",
    playbackRate: 1,
    supportedMediaCommands: 0,
    commands: supportedCommandsFor(0),
    deviceName: "",
    activeAppName: "",
    activeAppId: "",
    receiverStatusText: "",
    queue: [],
    volumeLevel: null,
    muted: false
  };
}

function unwrapCastResult(result, fallbackMessage) {
  const unwrapped = Result.unwrapWithErr(result);
  if (!unwrapped.isOk) {
    throw new Error(formatCastError(unwrapped.value) || fallbackMessage);
  }
  return unwrapped.value;
}

async function refreshPlaybackStatus() {
  if (!currentCast) {
    return getCachedPlaybackStatus();
  }

  const status = unwrapCastResult(await currentCast.mediaApp.getStatus(), "Could not read media status");
  let volume = currentCast.playback;
  if (currentCast.receiver) {
    try {
      volume = unwrapCastResult(await currentCast.receiver.getVolume(), "Could not read volume");
    } catch {
      volume = currentCast.playback;
    }
    try {
      currentCast.receiverStatus = unwrapCastResult(await currentCast.receiver.getStatus(), "Could not read receiver status");
    } catch {
      currentCast.receiverStatus = currentCast.receiverStatus || null;
    }
  }

  currentCast.playback = normalizePlaybackStatus(status, volume);
  rememberPlaybackPosition(currentCast.playback);
  sendCastStatus({
    state: currentCast.playback.playerState === "PLAYING" ? "casting" : "ready",
    message: `Playback ${currentCast.playback.playerState.toLowerCase()}`
  });
  return currentCast.playback;
}

async function closeCurrentCast() {
  if (!currentCast) return;
  try {
    try {
      await refreshPlaybackStatus();
    } catch {
      rememberPlaybackPosition();
    }
    await currentCast.mediaApp.stop();
    const activeApp = mediaApplicationFromStatus(currentCast.receiverStatus);
    if (activeApp?.sessionId && currentCast.receiver) {
      try {
        unwrapCastResult(await currentCast.receiver.stop(activeApp.sessionId), "Could not stop receiver app");
      } catch {
        // Media stop already ran; receiver app shutdown is best effort.
      }
    }
  } finally {
    if (currentCast.receiver) {
      currentCast.receiver.dispose();
    }
    currentCast.mediaApp.dispose();
    currentCast.client.close();
    currentCast = null;
  }
}

function formatCastError(error) {
  if (!error) return "Could not launch or load media";
  if (typeof error === "string") return error;
  return error.message || JSON.stringify(error);
}

function selectedDeviceOrThrow() {
  const device = castDevices.get(currentDeviceId);
  if (!device) {
    throw new Error("Select a Chromecast device first");
  }
  return device;
}

const MAX_RECONNECT_FAILURES = 3;

function handleActiveCastLost() {
  // Called when the active session's TV stays unreachable across several reconnect
  // attempts. Tear the session down so the renderer leaves the "playing" state and
  // re-enables joining a session once the TV comes back.
  if (!currentCast) return;
  rememberPlaybackPosition();
  try {
    currentCast.client.close();
  } catch {
    // Best effort; the socket is already gone.
  }
  try {
    currentCast.mediaApp?.dispose?.();
  } catch {
    // Best effort cleanup.
  }
  try {
    currentCast.receiver?.dispose?.();
  } catch {
    // Best effort cleanup.
  }
  currentCast = null;
  sendCastStatus({
    state: "stopped",
    message: "TV đã ngắt kết nối."
  });
}

function attachClientErrorGuard(client) {
  // PersistentClient re-emits the underlying socket 'error' event. A sleeping or
  // powered-off TV (or a network blip) resets the TLS socket with ECONNRESET; an
  // EventEmitter that emits 'error' with no listener rethrows it as an uncaught
  // exception and crashes the app. Attaching this guard keeps the error handled
  // so the built-in heartbeat reconnect can recover the session instead.
  let reconnectFailures = 0;
  let dropNotified = false;
  const isActiveClient = () => Boolean(currentCast && currentCast.client === client);

  client.on("error", (error) => {
    console.warn("Chromecast client error:", error?.message || error);
  });
  client.on("close", () => {
    console.warn("Chromecast client connection closed; reconnect will be attempted if active.");
  });
  client.on("reconnecting", () => {
    if (!isActiveClient() || dropNotified) return;
    dropNotified = true;
    sendCastStatus({
      state: "loading",
      message: "Mất kết nối TV, đang thử kết nối lại..."
    });
  });
  client.on("reconnect", (error) => {
    if (!isActiveClient()) return;
    if (error) {
      reconnectFailures += 1;
      if (reconnectFailures >= MAX_RECONNECT_FAILURES) {
        handleActiveCastLost();
      }
      return;
    }
    reconnectFailures = 0;
    dropNotified = false;
    sendCastStatus({
      state: "casting",
      message: `Đã kết nối lại với ${currentCast?.device?.name || "TV"}.`
    });
  });
}

async function connectToDevice(device) {
  const client = new PersistentClient({
    host: device.host,
    port: device.port || 8009
  });
  attachClientErrorGuard(client);
  try {
    await client.connect();
  } catch (error) {
    // Stop the heartbeat/reconnect loop on a client we are about to discard so a
    // failed first attempt does not keep retrying to the TV in the background.
    try {
      client.close();
    } catch {
      // Best effort.
    }
    throw error;
  }
  return client;
}

ipcMain.handle("app-info", () => {
  const appState = readAppState();
  const smokeStartPageUrl = process.env.MOVIE_CAST_BROWSER_SMOKE === "1" ? `file://${path.join(__dirname, "..", "sample", "sample.html")}` : "";
  const startPageUrl = process.env.MOVIE_CAST_BROWSER_START_URL || smokeStartPageUrl || appState.lastPageUrl;
  lastPageUrl = startPageUrl || "";

  return {
    webviewPreloadPath: `file://${path.join(__dirname, "webview-preload.js")}`,
    startPageUrl,
    history: appState.history,
    appMuted: appState.appMuted,
    userAgent: process.env.MOVIE_CAST_BROWSER_USER_AGENT || DEFAULT_USER_AGENT
  };
});

ipcMain.handle("page-updated", (_event, payload) => {
  return updatePageHistory(payload);
});

ipcMain.handle("clear-history", () => {
  return clearPageHistory();
});

ipcMain.handle("set-app-muted", (_event, muted) => {
  return updateAppMuted(muted);
});

ipcMain.handle("open-external", async (_event, url) => {
  await shell.openExternal(url);
  return true;
});

ipcMain.handle("start-discovery", () => {
  restartDiscovery();
  return true;
});

ipcMain.handle("select-device", (_event, deviceId) => {
  currentDeviceId = deviceId;
  sendDevices();
  return true;
});

ipcMain.handle("cast-media", async (_event, candidate) => {
  if (!candidate?.url) {
    throw new Error("Missing media URL");
  }

  if (!bonjourBrowser) {
    startDiscovery();
  }

  const device = selectedDeviceOrThrow();

  const preparedCandidate = await prepareCandidateForCast(candidate);
  const media = toChromecastMedia(preparedCandidate);
  const activeTrackIds = activeTrackIdsFor(preparedCandidate);
  const resumeTime = resumeTimeFor(candidate.url);
  sendCastStatus({
    state: "loading",
    message: activeTrackIds.length ? `Đang gửi video và phụ đề tới ${device.name}` : `Đang gửi video tới ${device.name}`
  });

  if (currentCast) {
    await closeCurrentCast();
  }

  const client = await connectToDevice(device);
  const receiver = ReceiverController.createReceiver({ client });

  const launched = await DefaultMediaApp.launchAndJoin({ client }).then(Result.unwrapWithErr);
  if (!launched.isOk) {
    receiver.dispose();
    client.close();
    throw new Error(formatCastError(launched.value));
  }

  const loaded = await launched.value.load({
    media,
    autoplay: true,
    currentTime: resumeTime,
    activeTrackIds
  }).then(Result.unwrapWithErr);

  if (!loaded.isOk) {
    launched.value.dispose();
    receiver.dispose();
    client.close();
    throw new Error(formatCastError(loaded.value));
  }

  currentCast = {
    client,
    mediaApp: launched.value,
    receiver,
    device,
    receiverStatus: null,
    queue: [queueItemForCandidate(preparedCandidate)],
    playback: null
  };
  currentCast.playback = normalizePlaybackStatus(loaded.value);

  sendCastStatus({
    state: "casting",
    message: resumeTime > 0 ? `Casting to ${device.name} from ${Math.floor(resumeTime)}s` : `Casting to ${device.name}`,
    mediaUrl: candidate.url
  });

  return true;
});

ipcMain.handle("join-cast-session", async () => {
  if (currentCast) {
    return refreshPlaybackStatus();
  }

  const device = selectedDeviceOrThrow();
  sendCastStatus({
    state: "loading",
    message: `Connecting to active session on ${device.name}`
  });

  const client = await connectToDevice(device);
  const receiver = ReceiverController.createReceiver({ client });
  const joined = await DefaultMediaApp.join({ client }).then(Result.unwrapWithErr);
  if (!joined.isOk) {
    receiver.dispose();
    client.close();
    throw new Error(formatCastError(joined.value) || "No active media session found");
  }

  currentCast = {
    client,
    mediaApp: joined.value,
    receiver,
    device,
    receiverStatus: null,
    queue: [],
    playback: null
  };

  const playback = await refreshPlaybackStatus();
  sendCastStatus({
    state: "casting",
    message: `Connected to active session on ${device.name}`
  });
  return playback;
});

ipcMain.handle("queue-media", async (_event, candidate) => {
  if (!currentCast) {
    throw new Error("No active cast session");
  }
  if (!candidate?.url) {
    throw new Error("Missing media URL");
  }

  const preparedCandidate = await prepareCandidateForCast(candidate);
  const media = toChromecastMedia(preparedCandidate);
  const activeTrackIds = activeTrackIdsFor(preparedCandidate);
  const status = unwrapCastResult(await currentCast.mediaApp.queueInsert({
    items: [
      {
        media,
        autoplay: true,
        activeTrackIds
      }
    ]
  }), "Could not queue media");

  currentCast.queue = [
    ...(currentCast.queue || []),
    queueItemForCandidate(preparedCandidate)
  ];
  currentCast.playback = normalizePlaybackStatus(status);
  rememberPlaybackPosition(currentCast.playback);
  sendCastStatus({
    state: "casting",
    message: "Added media to TV queue"
  });

  return {
    playback: currentCast.playback,
    queue: currentCast.queue
  };
});

ipcMain.handle("cast-status-request", async () => {
  return refreshPlaybackStatus();
});

ipcMain.handle("cast-control", async (_event, payload) => {
  if (!currentCast) {
    throw new Error("No active cast session");
  }

  const action = payload?.action;
  if (action === "play") {
    unwrapCastResult(await currentCast.mediaApp.play(), "Could not play");
  } else if (action === "pause") {
    unwrapCastResult(await currentCast.mediaApp.pause(), "Could not pause");
  } else if (action === "seek-relative") {
    unwrapCastResult(await currentCast.mediaApp.seek({ relativeTime: Number(payload.seconds || 0) }), "Could not seek");
  } else if (action === "seek") {
    unwrapCastResult(await currentCast.mediaApp.seek({ currentTime: Number(payload.currentTime || 0) }), "Could not seek");
  } else if (action === "volume") {
    if (!currentCast.receiver) throw new Error("Volume control unavailable");
    const volume = unwrapCastResult(await currentCast.receiver.setVolume({ level: Number(payload.level) }), "Could not set volume");
    currentCast.playback = {
      ...getCachedPlaybackStatus(),
      volumeLevel: volume.level,
      muted: Boolean(volume.muted)
    };
  } else if (action === "mute") {
    if (!currentCast.receiver) throw new Error("Mute control unavailable");
    const volume = unwrapCastResult(await currentCast.receiver.setVolume({ mute: Boolean(payload.muted) }), "Could not set mute");
    currentCast.playback = {
      ...getCachedPlaybackStatus(),
      volumeLevel: volume.level,
      muted: Boolean(volume.muted)
    };
  } else {
    throw new Error(`Unknown cast control: ${action}`);
  }

  return refreshPlaybackStatus();
});

ipcMain.handle("stop-cast", async () => {
  await closeCurrentCast();

  sendCastStatus({
    state: "stopped",
    message: "Stopped casting"
  });

  return true;
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
