import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import {
  ArrowLeft,
  ArrowRight,
  Cast,
  CircleStop,
  Clapperboard,
  Clock,
  History,
  Link2,
  Loader2,
  MonitorPlay,
  MonitorUp,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SkipBack,
  SkipForward,
  Trash2,
  Volume2,
  VolumeX
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

const DEFAULT_PLAYBACK = {
  connected: false,
  playerState: "IDLE",
  currentTime: 0,
  duration: 0,
  title: "",
  mediaUrl: "",
  volumeLevel: null,
  muted: false
};

const SUBTITLE_AUTO = "__auto__";
const SUBTITLE_OFF = "__off__";

const CAST_STATE_LABELS = {
  ready: "Sẵn sàng",
  discovering: "Đang quét",
  loading: "Đang gửi",
  casting: "Đang cast",
  stopped: "Đã dừng",
  error: "Lỗi"
};

const CAST_STATUS_POLL_MS = 1000;

function normalizeNavigationUrl(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return "";
  if (/^(https?|file):\/\//i.test(value)) return value;
  if (value.includes(".") && !value.includes(" ")) return `https://${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

function mediaTypeLabel(contentType, url) {
  const value = `${contentType || ""} ${url || ""}`.toLowerCase();
  if (value.includes("mpegurl") || value.includes(".m3u8") || value.includes("/player/master/")) return "HLS";
  if (value.includes("dash") || value.includes(".mpd")) return "DASH";
  if (value.includes("webm")) return "WebM";
  if (value.includes("mp4")) return "MP4";
  return "Video";
}

function contentTypeForManualUrl(url) {
  const type = mediaTypeLabel("", url);
  if (type === "HLS") return "application/x-mpegURL";
  if (type === "DASH") return "application/dash+xml";
  if (type === "WebM") return "video/webm";
  return "video/mp4";
}

function hostForUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

function splitDeviceLabel(rawName) {
  const full = String(rawName || "").trim();
  const match = full.match(/^(.+?)[-_\s]([0-9a-f]{12,})$/i);
  if (match && match[1]) {
    return { name: match[1].replace(/[-_\s]+$/, ""), shortId: match[2] };
  }
  return { name: full || "Chromecast", shortId: "" };
}

function isLikelyAdCandidate(candidate) {
  const value = [
    candidate?.url,
    candidate?.title,
    candidate?.server,
    hostForUrl(candidate?.url || "")
  ].join(" ").toLowerCase();

  return /adcenter|\/ads?\/|adserver|banner|popup|promos?|casino|bet|qq88|net88|ok9|gem88|debet|sunwin|vinfast|shopee|tiktok/.test(value);
}

function classifyCandidate(candidate) {
  if (!candidate?.url) {
    return {
      kind: "unknown",
      label: "Không rõ",
      rank: 0,
      visible: false
    };
  }

  if (candidate.source === "Manual") {
    return {
      kind: "manual",
      label: "Link thủ công",
      rank: 320,
      visible: true
    };
  }

  if (isLikelyAdCandidate(candidate)) {
    return {
      kind: "ad",
      label: "Quảng cáo",
      rank: -100,
      visible: false
    };
  }

  if (candidate.candidateKind === "episode" || candidate.confidence === "high") {
    return {
      kind: "episode",
      label: "Tập phim",
      rank: 260 + (candidate.score || 0),
      visible: true
    };
  }

  if (["DOM", "Network", "Fetch", "XHR", "Page data"].includes(candidate.source)) {
    return {
      kind: "detected",
      label: "Video nghi vấn",
      rank: 80 + (candidate.score || 0),
      visible: true
    };
  }

  return {
    kind: "other",
    label: "Link khác",
    rank: 20 + (candidate.score || 0),
    visible: false
  };
}

function candidateRank(candidate) {
  return classifyCandidate(candidate).rank;
}

function safeTitle(candidate) {
  const classification = classifyCandidate(candidate);
  if (classification.kind === "episode") return "Link tập phim đề xuất";
  if (classification.kind === "manual") return "Link nhập thủ công";
  if (candidate?.title) return candidate.title;
  return `${mediaTypeLabel(candidate?.contentType, candidate?.url)} từ ${hostForUrl(candidate?.url || "")}`;
}

function formatSeconds(value) {
  const seconds = Math.max(0, Math.floor(Number(value || 0)));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function resolutionLabel(height) {
  const value = Number(height || 0);
  if (value <= 0) return "";
  if (value >= 2160) return "4K";
  if (value >= 1440) return "1440p";
  if (value >= 1080) return "1080p";
  if (value >= 720) return "720p";
  if (value >= 480) return "480p";
  if (value >= 360) return "360p";
  return `${value}p`;
}

function uniqueQualityLabels(qualities) {
  const labels = [];
  for (const quality of qualities || []) {
    const label = resolutionLabel(quality?.height);
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
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

function subtitleRank(subtitle) {
  return (subtitle?.isDefault ? 1000 : 0) + Number(subtitle?.score || 0) + Number(subtitle?.seenAt || 0) / 10000000000000;
}

const REMEMBERED_DEVICE_KEY = "movieCast.lastDevice";

function readRememberedDevice() {
  try {
    const raw = window.localStorage.getItem(REMEMBERED_DEVICE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.id ? parsed : null;
  } catch (error) {
    return null;
  }
}

function writeRememberedDevice(device) {
  if (!device || !device.id) return;
  try {
    window.localStorage.setItem(
      REMEMBERED_DEVICE_KEY,
      JSON.stringify({ id: device.id, name: device.name || "" })
    );
  } catch (error) {
    // Remembering the last device is best-effort; ignore storage failures.
  }
}

function deviceMatchesRemembered(device, remembered) {
  if (!device || !remembered) return false;
  if (remembered.id && device.id === remembered.id) return true;
  if (remembered.name && device.name && device.name === remembered.name) return true;
  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isResumablePosition(position) {
  const currentTime = Number(position?.currentTime || 0);
  const duration = Number(position?.duration || 0);
  if (currentTime < 5) return false;
  if (duration > 0 && currentTime > duration - 20) return false;
  return true;
}

function resumableCurrentTime(position) {
  const currentTime = Number(position?.currentTime || 0);
  const duration = Number(position?.duration || 0);
  if (!isResumablePosition(position)) return 0;
  return duration > 0 ? clampNumber(currentTime, 0, duration) : currentTime;
}

function appMuteJavascript(muted) {
  const mutedValue = muted ? "true" : "false";
  return `
    (() => {
      window.__movieCastAppMuted = ${mutedValue};
      const applyMovieCastMute = () => {
        document.querySelectorAll("video,audio").forEach((media) => {
          if (window.__movieCastAppMuted) {
            if (typeof media.__movieCastPreviousVolume !== "number") {
              media.__movieCastPreviousVolume = media.volume;
            }
            media.muted = true;
            media.volume = 0;
          } else {
            media.muted = false;
            if (typeof media.__movieCastPreviousVolume === "number") {
              media.volume = media.__movieCastPreviousVolume;
              delete media.__movieCastPreviousVolume;
            }
          }
        });
      };
      applyMovieCastMute();
      if (!window.__movieCastMuteObserver) {
        window.__movieCastMuteObserver = new MutationObserver(applyMovieCastMute);
        window.__movieCastMuteObserver.observe(document.documentElement || document.body, {
          childList: true,
          subtree: true
        });
      }
    })();
  `;
}

// A sleeping or just-woken TV usually fails the first connection then succeeds
// once it powers on, so only validation errors are treated as permanent.
function isRetryableCastError(message) {
  const text = String(message || "").toLowerCase();
  if (text.includes("missing media")) return false;
  if (text.includes("select a chromecast")) return false;
  return true;
}

function App() {
  const webviewRef = useRef(null);
  const webviewDomReadyRef = useRef(false);
  const loadingTimerRef = useRef(null);
  const scanTimerRef = useRef(null);
  const resizingRef = useRef(false);
  const autoSelectedRef = useRef(false);
  const appMutedRef = useRef(false);
  const [appInfo, setAppInfo] = useState(null);
  const [urlInput, setUrlInput] = useState("");
  const [manualUrl, setManualUrl] = useState("");
  const [history, setHistory] = useState([]);
  const [candidates, setCandidates] = useState(() => new Map());
  const [selectedCandidateUrl, setSelectedCandidateUrl] = useState(null);
  const [subtitles, setSubtitles] = useState(() => new Map());
  const [selectedSubtitleUrl, setSelectedSubtitleUrl] = useState(SUBTITLE_AUTO);
  const [devices, setDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(null);
  const [status, setStatus] = useState({
    state: "ready",
    message: "Chọn một video và một thiết bị để bắt đầu."
  });
  const [playback, setPlayback] = useState(DEFAULT_PLAYBACK);
  const [loadingPage, setLoadingPage] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [panelWidth, setPanelWidth] = useState(352);
  const [isResizing, setIsResizing] = useState(false);
  const [mediaInfo, setMediaInfo] = useState(null);
  const [castBusy, setCastBusy] = useState(false);
  const [castAttempt, setCastAttempt] = useState(0);
  const [appMuted, setAppMuted] = useState(false);
  const [resumePrompt, setResumePrompt] = useState(null);

  const allCandidates = useMemo(() => {
    return Array.from(candidates.values())
      .sort((a, b) => candidateRank(b) - candidateRank(a) || (b.score || 0) - (a.score || 0) || (b.seenAt || 0) - (a.seenAt || 0))
      .slice(0, 40);
  }, [candidates]);

  const visibleCandidates = useMemo(() => allCandidates.filter((candidate) => classifyCandidate(candidate).visible), [allCandidates]);
  const recommendedCandidate = visibleCandidates[0] || null;
  const displayedCandidates = recommendedCandidate ? [recommendedCandidate] : [];
  const selectedCandidate = selectedCandidateUrl ? candidates.get(selectedCandidateUrl) || null : null;
  const visibleSubtitles = useMemo(() => {
    const merged = [
      ...(selectedCandidate?.subtitles || []),
      ...Array.from(subtitles.values())
    ].filter((subtitle) => subtitle?.url && subtitle.castSupported !== false);
    const deduped = new Map();
    for (const subtitle of merged) {
      const existing = deduped.get(subtitle.url);
      if (!existing || subtitleRank(subtitle) >= subtitleRank(existing)) {
        deduped.set(subtitle.url, subtitle);
      }
    }
    return Array.from(deduped.values()).sort((a, b) => subtitleRank(b) - subtitleRank(a)).slice(0, 24);
  }, [selectedCandidate, subtitles]);
  const selectedSubtitle = useMemo(() => {
    if (selectedSubtitleUrl === SUBTITLE_OFF) return null;
    if (selectedSubtitleUrl === SUBTITLE_AUTO) {
      return visibleSubtitles.find((subtitle) => subtitle.isDefault) || visibleSubtitles[0] || null;
    }
    return visibleSubtitles.find((subtitle) => subtitle.url === selectedSubtitleUrl) || null;
  }, [selectedSubtitleUrl, visibleSubtitles]);
  const selectedCandidateForCast = useMemo(() => {
    if (!selectedCandidate) return null;
    return {
      ...selectedCandidate,
      subtitles: selectedSubtitle ? [selectedSubtitle] : []
    };
  }, [selectedCandidate, selectedSubtitle]);
  const hiddenCount = Math.max(0, allCandidates.length - (recommendedCandidate ? 1 : 0));
  const castStateLabel = CAST_STATE_LABELS[status.state] || CAST_STATE_LABELS.ready;
  const canCast = Boolean(selectedCandidateForCast && selectedDeviceId);
  const canJoinSession = Boolean(selectedDeviceId && !playback.connected);
  const canQueueSelected = Boolean(selectedCandidateForCast && playback.connected);
  const selectedDevice = devices.find((device) => device.id === selectedDeviceId || device.selected) || null;
  const sessionDeviceName = playback.deviceName || selectedDevice?.name || "Chưa chọn TV";
  const queueCount = Array.isArray(playback.queue) ? playback.queue.length : 0;
  const linkSummary = recommendedCandidate ? mediaTypeLabel(recommendedCandidate.contentType, recommendedCandidate.url) : "Chưa có link";

  const setStatusMessage = useCallback((message, state = "ready") => {
    setStatus({ message, state });
  }, []);

  const navigateTo = useCallback((rawUrl) => {
    const url = normalizeNavigationUrl(rawUrl);
    if (!url) return;
    setCandidates(new Map());
    setSelectedCandidateUrl(null);
    setSubtitles(new Map());
    setSelectedSubtitleUrl(SUBTITLE_AUTO);
    setUrlInput(url);
    if (webviewRef.current) {
      webviewRef.current.src = url;
    }
    window.movieCast.updatePage({ url }).catch(() => {});
  }, []);

  const addCandidate = useCallback((candidate) => {
    if (!candidate?.url || candidate.url.startsWith("blob:")) return;
    setCandidates((previous) => {
      const existing = previous.get(candidate.url);
      const next = {
        ...existing,
        ...candidate,
        score: Math.max(existing?.score || 0, candidate.score || 0),
        seenAt: Date.now()
      };
      const copy = new Map(previous);
      copy.set(candidate.url, next);
      return copy;
    });
  }, []);

  const addSubtitle = useCallback((subtitle) => {
    if (!subtitle?.url || subtitle.url.startsWith("blob:") || subtitle.castSupported === false) return;
    setSubtitles((previous) => {
      const existing = previous.get(subtitle.url);
      const next = {
        ...existing,
        ...subtitle,
        score: Math.max(existing?.score || 0, subtitle.score || 0),
        seenAt: Date.now()
      };
      const copy = new Map(previous);
      copy.set(subtitle.url, next);
      return copy;
    });
  }, []);

  const renderDevices = useCallback((nextDevices) => {
    setDevices(nextDevices);
    setSelectedDeviceId((current) => {
      const selected = nextDevices.find((device) => device.selected);
      if (selected) return selected.id;
      if (current && nextDevices.some((device) => device.id === current)) return current;
      return null;
    });
  }, []);

  const refreshPlaybackStatus = useCallback(async () => {
    try {
      const nextPlayback = await window.movieCast.getCastStatus();
      setPlayback(nextPlayback || DEFAULT_PLAYBACK);
      return nextPlayback;
    } catch (error) {
      setStatusMessage(error.message || "Không đọc được trạng thái TV.", "error");
      return null;
    }
  }, [setStatusMessage]);

  const applyAppMutedToWebview = useCallback((muted = appMutedRef.current) => {
    const webview = webviewRef.current;
    if (!webview) return;
    try {
      webview.setAudioMuted?.(Boolean(muted));
    } catch {
      // Ignore webview API gaps; injected media mute below is the fallback.
    }
    try {
      webview.audioMuted = Boolean(muted);
    } catch {
      // Best effort for older Electron webview implementations.
    }
    if (!webviewDomReadyRef.current || typeof webview.executeJavaScript !== "function") return;
    try {
      webview.executeJavaScript(appMuteJavascript(Boolean(muted))).catch(() => {});
    } catch {
      // Electron throws synchronously if the webview is not ready for script execution.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.movieCast.getAppInfo().then((info) => {
      if (cancelled) return;
      setAppInfo(info);
      setHistory(Array.isArray(info.history) ? info.history : []);
      appMutedRef.current = Boolean(info.appMuted);
      setAppMuted(Boolean(info.appMuted));
    }).catch((error) => {
      setStatusMessage(error.message || "Không khởi động được app.", "error");
    });
    return () => {
      cancelled = true;
    };
  }, [setStatusMessage]);

  useEffect(() => {
    const offCandidates = window.movieCast.onMediaCandidate(addCandidate);
    const offSubtitles = window.movieCast.onSubtitleCandidate(addSubtitle);
    const offDevices = window.movieCast.onCastDevices(renderDevices);
    const offHistory = window.movieCast.onHistoryUpdated((nextHistory) => {
      setHistory(Array.isArray(nextHistory) ? nextHistory : []);
    });
    const offAppMuted = window.movieCast.onAppMutedUpdated((muted) => {
      appMutedRef.current = muted;
      setAppMuted(muted);
      applyAppMutedToWebview(muted);
    });
    const offStatus = window.movieCast.onCastStatus((nextStatus) => {
      setStatus({
        state: nextStatus.state || "ready",
        message: nextStatus.message || "Sẵn sàng"
      });
      if (nextStatus.playback) {
        setPlayback(nextStatus.playback);
      }
    });

    return () => {
      offCandidates();
      offSubtitles();
      offDevices();
      offHistory();
      offAppMuted();
      offStatus();
    };
  }, [addCandidate, addSubtitle, applyAppMutedToWebview, renderDevices]);

  useEffect(() => {
    appMutedRef.current = appMuted;
    applyAppMutedToWebview(appMuted);
  }, [appMuted, applyAppMutedToWebview]);

  useEffect(() => {
    const visibleUrls = new Set(displayedCandidates.map((candidate) => candidate.url));
    if (!recommendedCandidate) {
      if (selectedCandidateUrl) setSelectedCandidateUrl(null);
      return;
    }
    if (!selectedCandidateUrl || !visibleUrls.has(selectedCandidateUrl)) {
      setSelectedCandidateUrl(recommendedCandidate.url);
    }
  }, [displayedCandidates, recommendedCandidate, selectedCandidateUrl]);

  useEffect(() => {
    if (!appInfo) return;
    const webview = webviewRef.current;
    if (!webview) return;

    const hideLoading = () => {
      setLoadingPage(false);
      clearTimeout(loadingTimerRef.current);
    };

    const updateFromWebview = () => {
      const url = webview.getURL?.() || webview.src || "";
      if (!url) return;
      const title = webview.getTitle?.() || "";
      setUrlInput(url);
      window.movieCast.updatePage({ url, title }).catch(() => {});
    };

    const handleStart = () => {
      webviewDomReadyRef.current = false;
      setLoadingPage(true);
      clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = setTimeout(() => {
        setLoadingPage(false);
      }, 6500);
    };

    const handleStop = () => {
      hideLoading();
      updateFromWebview();
      applyAppMutedToWebview();
    };

    const handleDomReady = () => {
      webviewDomReadyRef.current = true;
      hideLoading();
      applyAppMutedToWebview();
    };

    const handleFail = (event) => {
      if (event.isMainFrame === false || event.errorCode === -3) return;
      hideLoading();
      setStatusMessage(`Không mở được trang: ${event.errorDescription}`, "error");
    };

    const handleNavigate = (event) => {
      const nextUrl = event.url || webview.getURL?.() || "";
      if (!nextUrl) return;
      setUrlInput(nextUrl);
      window.movieCast.updatePage({ url: nextUrl, title: webview.getTitle?.() || "" }).catch(() => {});
    };

    const handleTitle = () => {
      const title = webview.getTitle?.();
      if (title) {
        document.title = `Movie Cast Browser - ${title}`;
        const url = webview.getURL?.() || "";
        if (url) {
          window.movieCast.updatePage({ url, title }).catch(() => {});
        }
      }
    };

    const handleIpc = (event) => {
      if (event.channel === "media-candidate") {
        addCandidate(event.args?.[0]);
      } else if (event.channel === "subtitle-candidate") {
        addSubtitle(event.args?.[0]);
      }
    };

    webview.addEventListener("did-start-loading", handleStart);
    webview.addEventListener("did-stop-loading", handleStop);
    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-fail-load", handleFail);
    webview.addEventListener("did-navigate", handleNavigate);
    webview.addEventListener("page-title-updated", handleTitle);
    webview.addEventListener("ipc-message", handleIpc);

    if (appInfo.startPageUrl) {
      navigateTo(appInfo.startPageUrl);
    }

    return () => {
      webview.removeEventListener("did-start-loading", handleStart);
      webview.removeEventListener("did-stop-loading", handleStop);
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-fail-load", handleFail);
      webview.removeEventListener("did-navigate", handleNavigate);
      webview.removeEventListener("page-title-updated", handleTitle);
      webview.removeEventListener("ipc-message", handleIpc);
      webviewDomReadyRef.current = false;
      clearTimeout(loadingTimerRef.current);
    };
  }, [addCandidate, addSubtitle, appInfo, applyAppMutedToWebview, navigateTo, setStatusMessage]);

  useEffect(() => {
    if (!playback.connected) return undefined;
    const interval = setInterval(() => {
      refreshPlaybackStatus();
    }, CAST_STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, [playback.connected, refreshPlaybackStatus]);

  useEffect(() => () => clearTimeout(scanTimerRef.current), []);

  useEffect(() => {
    if (autoSelectedRef.current || selectedDeviceId || devices.length === 0) return;
    const remembered = readRememberedDevice();
    if (!remembered) return;
    const match = devices.find((device) => deviceMatchesRemembered(device, remembered));
    if (!match) return;
    autoSelectedRef.current = true;
    setSelectedDeviceId(match.id);
    setDevices((previous) => previous.map((device) => ({
      ...device,
      selected: device.id === match.id
    })));
    window.movieCast.selectDevice(match.id).catch(() => {});
  }, [devices, selectedDeviceId]);

  const handleNavigateSubmit = (event) => {
    event.preventDefault();
    navigateTo(urlInput);
  };

  const handleManualSubmit = (event) => {
    event.preventDefault();
    const url = normalizeNavigationUrl(manualUrl);
    if (!url) return;
    addCandidate({
      url,
      contentType: contentTypeForManualUrl(url),
      source: "Manual",
      score: 100,
      seenAt: Date.now()
    });
    setManualUrl("");
  };

  const handleScan = useCallback(async () => {
    clearTimeout(scanTimerRef.current);
    setScanning(true);
    try {
      setStatusMessage("Đang quét Chromecast trong mạng LAN.", "discovering");
      await window.movieCast.startDiscovery();
    } catch (error) {
      setScanning(false);
      setStatusMessage(error.message || "Không quét được Chromecast.", "error");
      return;
    }
    scanTimerRef.current = setTimeout(() => setScanning(false), 6000);
  }, [setStatusMessage]);

  useEffect(() => {
    handleScan();
  }, [handleScan]);

  const handleSelectDevice = async (deviceId) => {
    try {
      setSelectedDeviceId(deviceId);
      await window.movieCast.selectDevice(deviceId);
      setDevices((previous) => previous.map((device) => ({
        ...device,
        selected: device.id === deviceId
      })));
    } catch (error) {
      setStatusMessage(error.message || "Không chọn được thiết bị.", "error");
    }
  };

  const chooseCastStartTime = useCallback(async (candidate) => {
    let savedPosition = null;
    try {
      savedPosition = await window.movieCast.getPlaybackPosition(candidate.url);
    } catch (error) {
      setStatusMessage(error.message || "Không đọc được vị trí xem đã lưu.", "error");
    }
    if (!isResumablePosition(savedPosition)) return 0;
    return new Promise((resolve) => {
      setResumePrompt({
        candidate,
        position: savedPosition,
        onStartOver: () => {
          setResumePrompt(null);
          resolve(0);
        },
        onContinue: () => {
          setResumePrompt(null);
          resolve(Number(savedPosition.currentTime || 0));
        }
      });
    });
  }, [setStatusMessage]);

  const handleCast = async () => {
    if (!selectedCandidateForCast || castBusy) return;
    const startTime = await chooseCastStartTime(selectedCandidateForCast);
    const maxAttempts = 4;
    setCastBusy(true);
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        setCastAttempt(attempt);
        if (attempt === 1) {
          setStatusMessage("Đang gửi video sang TV.", "loading");
        }
        try {
          await window.movieCast.castMedia({
            candidate: selectedCandidateForCast,
            startTime
          });
          await refreshPlaybackStatus();
          if (selectedDevice) writeRememberedDevice(selectedDevice);
          return;
        } catch (error) {
          const message = error?.message || "";
          if (attempt === maxAttempts || !isRetryableCastError(message)) {
            setStatusMessage(message || "Không cast được video này.", "error");
            return;
          }
          setStatusMessage(
            `TV chưa sẵn sàng (có thể đang bật), đang thử lại (${attempt + 1}/${maxAttempts})...`,
            "loading"
          );
          await delay(attempt * 1500);
        }
      }
    } finally {
      setCastBusy(false);
      setCastAttempt(0);
    }
  };

  const handleJoinCastSession = async () => {
    try {
      setStatusMessage("Đang kết nối phiên đang chạy trên TV.", "loading");
      const nextPlayback = await window.movieCast.joinCastSession();
      setPlayback(nextPlayback || DEFAULT_PLAYBACK);
      if (selectedDevice) writeRememberedDevice(selectedDevice);
    } catch (error) {
      setStatusMessage(error.message || "Không tìm thấy phiên cast đang chạy.", "error");
    }
  };

  const handleQueueSelected = async () => {
    if (!selectedCandidateForCast) return;
    try {
      const result = await window.movieCast.queueMedia(selectedCandidateForCast);
      setPlayback(result?.playback || DEFAULT_PLAYBACK);
      setStatusMessage("Đã thêm link vào hàng đợi TV.", "casting");
    } catch (error) {
      setStatusMessage(error.message || "Không thêm được vào hàng đợi TV.", "error");
    }
  };

  const handleStop = async () => {
    try {
      await window.movieCast.stopCast();
      setPlayback(DEFAULT_PLAYBACK);
    } catch (error) {
      setStatusMessage(error.message || "Không dừng được cast.", "error");
    }
  };

  const sendControl = async (payload) => {
    try {
      const nextPlayback = await window.movieCast.controlCast(payload);
      setPlayback(nextPlayback || DEFAULT_PLAYBACK);
    } catch (error) {
      setStatusMessage(error.message || "Không điều khiển được TV.", "error");
    }
  };

  const handleClearCandidates = () => {
    setCandidates(new Map());
    setSelectedCandidateUrl(null);
    setSubtitles(new Map());
    setSelectedSubtitleUrl(SUBTITLE_AUTO);
  };

  const handleClearHistory = async () => {
    try {
      const nextState = await window.movieCast.clearHistory();
      setHistory(Array.isArray(nextState?.history) ? nextState.history : []);
    } catch (error) {
      setStatusMessage(error.message || "Không xóa được lịch sử.", "error");
    }
  };

  const goBack = () => {
    const webview = webviewRef.current;
    if (webview?.canGoBack?.()) webview.goBack();
  };

  const goForward = () => {
    const webview = webviewRef.current;
    if (webview?.canGoForward?.()) webview.goForward();
  };

  const reload = () => {
    webviewRef.current?.reload?.();
  };

  const handleToggleAppMuted = async () => {
    const previousMuted = appMutedRef.current;
    const nextMuted = !previousMuted;
    appMutedRef.current = nextMuted;
    setAppMuted(nextMuted);
    applyAppMutedToWebview(nextMuted);
    try {
      const persistedMuted = await window.movieCast.setAppMuted(nextMuted);
      appMutedRef.current = Boolean(persistedMuted);
      setAppMuted(Boolean(persistedMuted));
      applyAppMutedToWebview(Boolean(persistedMuted));
    } catch (error) {
      appMutedRef.current = previousMuted;
      setAppMuted(previousMuted);
      applyAppMutedToWebview(previousMuted);
      setStatusMessage(error.message || "Không lưu được cấu hình âm thanh app.", "error");
    }
  };

  const startResize = (event) => {
    event.preventDefault();
    resizingRef.current = true;
    setIsResizing(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleResizeMove = (event) => {
    if (!resizingRef.current) return;
    const next = window.innerWidth - event.clientX - 12;
    setPanelWidth(clampNumber(next, 300, 640));
  };

  const stopResize = (event) => {
    if (!resizingRef.current) return;
    resizingRef.current = false;
    setIsResizing(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const handleResizeKey = (event) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setPanelWidth((width) => clampNumber(width + 16, 300, 640));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setPanelWidth((width) => clampNumber(width - 16, 300, 640));
    }
  };

  return (
    <main className={cn("app-shell", isResizing && "resizing")} style={{ "--panel-width": `${panelWidth}px` }}>
      <section className="browser-pane">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <Cast className="h-4 w-4" />
            </span>
            <span className="brand-label">Movie Cast Browser</span>
          </div>

          <div className="nav-controls" aria-label="Điều hướng">
            <Button variant="outline" size="icon" title="Quay lại" aria-label="Quay lại" onClick={goBack}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon" title="Đi tiếp" aria-label="Đi tiếp" onClick={goForward}>
              <ArrowRight className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon" title="Tải lại" aria-label="Tải lại" onClick={reload}>
              <RotateCcw className="h-4 w-4" />
            </Button>
            <Button
              variant={appMuted ? "default" : "outline"}
              size="icon"
              title={appMuted ? "Bật âm thanh app" : "Tắt âm thanh app"}
              aria-label={appMuted ? "Bật âm thanh app" : "Tắt âm thanh app"}
              onClick={handleToggleAppMuted}
            >
              {appMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </Button>
          </div>

          <form className="url-form" onSubmit={handleNavigateSubmit}>
            <label htmlFor="urlInput">URL</label>
            <Input
              id="urlInput"
              className="h-9"
              type="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://..."
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
            />
            <Button type="submit" size="sm">Mở</Button>
          </form>
        </header>

        <div className="browser-frame">
          <webview
            ref={webviewRef}
            id="movieWebview"
            className="movie-webview"
            partition="persist:movie-cast-browser"
            allowpopups="true"
            preload={appInfo?.webviewPreloadPath || undefined}
            useragent={appInfo?.userAgent || undefined}
          />
          <div className={cn("loading-cover", loadingPage && "visible")}>
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Đang tải trang...</span>
          </div>
        </div>
      </section>

      <div
        className="panel-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Kéo để đổi độ rộng panel điều khiển"
        tabIndex={0}
        onPointerDown={startResize}
        onPointerMove={handleResizeMove}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
        onKeyDown={handleResizeKey}
      />

      <aside className="cast-panel">
        <Card className="side-section session-section border-0 bg-transparent shadow-none">
          <CardContent className="p-0">
            <div className="session-top">
              <div className="min-w-0">
                <span className="eyebrow">Phiên cast</span>
                <h1 className="session-title truncate">
                  {playback.connected ? playback.title || "Đang cast" : "Sẵn sàng cast phim"}
                </h1>
                <p id="statusText" className="session-status truncate">{status.message}</p>
              </div>
              <Badge id="castState" variant={status.state === "error" ? "warning" : "default"} className="shrink-0">
                {castStateLabel}
              </Badge>
            </div>
            <div className="session-stats">
              <span><MonitorUp className="h-3.5 w-3.5" />{sessionDeviceName}</span>
              <span><Link2 className="h-3.5 w-3.5" />{linkSummary}</span>
              <span><Clapperboard className="h-3.5 w-3.5" />Hàng đợi {queueCount}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="side-section border-0 bg-transparent shadow-none">
          <CardHeader className="section-header p-0">
            <CardTitle>Điều khiển TV</CardTitle>
          </CardHeader>
          <CardContent className="section-content flex flex-col gap-4 p-0">
            <div className="action-stack">
              <Button type="button" className="action-primary !h-11" onClick={handleCast} disabled={!canCast || castBusy}>
                {castBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Cast className="h-4 w-4" />}
                {castBusy ? (castAttempt > 1 ? `Đang thử lại (${castAttempt}/4)` : "Đang gửi...") : "Cast video"}
              </Button>
              <div className="action-pair">
                <Button type="button" variant="secondary" onClick={handleJoinCastSession} disabled={!canJoinSession}>
                  <RefreshCw className="h-4 w-4" />
                  Kết nối TV
                </Button>
                <Button type="button" variant="secondary" onClick={handleQueueSelected} disabled={!canQueueSelected}>
                  <Plus className="h-4 w-4" />
                  Thêm hàng đợi
                </Button>
              </div>
              <Button type="button" variant="ghost" className="action-stop" onClick={handleStop} disabled={!playback.connected}>
                <CircleStop className="h-4 w-4" />
                Dừng
              </Button>
            </div>

            {playback.connected ? (
              <TvControls playback={playback} onControl={sendControl} onRefresh={refreshPlaybackStatus} />
            ) : (
              <p className="controller-hint">Bộ điều khiển sẽ hiện khi đang cast. Chọn link và bấm Cast video.</p>
            )}
          </CardContent>
        </Card>

        <Card className="side-section border-0 bg-transparent shadow-none">
          <CardHeader className="section-header p-0">
            <CardTitle>Link phim</CardTitle>
            <div className="header-actions">
              <Badge variant={recommendedCandidate ? "default" : "secondary"}>{recommendedCandidate ? "1 link" : "0 link"}</Badge>
              <Button variant="outline" size="icon" title="Xóa danh sách" aria-label="Xóa danh sách" onClick={handleClearCandidates}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="section-content flex flex-col gap-3 p-0">
            {displayedCandidates.length === 0 ? (
              <div className="empty-state">Chưa có link tập phim.</div>
            ) : (
              <div className="candidate-list">
                {displayedCandidates.map((candidate, index) => (
                  <CandidateCard
                    key={candidate.url}
                    candidate={candidate}
                    selected={candidate.url === selectedCandidateUrl}
                    primary={index === 0}
                    onSelect={() => setSelectedCandidateUrl(candidate.url)}
                    info={mediaInfo && mediaInfo.url === candidate.url ? mediaInfo : null}
                  />
                ))}
              </div>
            )}

            {hiddenCount > 0 ? (
              <p className="filter-note">Đã lọc {hiddenCount} link không chắc chắn hoặc quảng cáo.</p>
            ) : null}

            <SubtitlePicker
              subtitles={visibleSubtitles}
              selectedSubtitleUrl={selectedSubtitleUrl}
              onSelect={setSelectedSubtitleUrl}
            />

            {selectedCandidate ? (
              <MediaPreview candidate={selectedCandidate} info={mediaInfo} onMeta={setMediaInfo} />
            ) : null}
          </CardContent>
        </Card>

        <Card className="side-section border-0 bg-transparent shadow-none">
          <CardHeader className="section-header p-0">
            <CardTitle>Thiết bị</CardTitle>
            <Button type="button" variant="secondary" size="sm" onClick={handleScan} disabled={scanning}>
              {scanning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : devices.length > 0 ? (
                <RefreshCw className="h-4 w-4" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              {scanning ? "Đang quét..." : devices.length > 0 ? "Làm mới" : "Quét"}
            </Button>
          </CardHeader>
          <CardContent className="section-content p-0">
            <DeviceList devices={devices} selectedDeviceId={selectedDeviceId} onSelect={handleSelectDevice} scanning={scanning} />
          </CardContent>
        </Card>

        <Card className="side-section border-0 bg-transparent shadow-none">
          <CardHeader className="section-header p-0">
            <CardTitle className="inline-flex items-center gap-2">
              <History className="h-4 w-4" />
              Lịch sử
            </CardTitle>
            <Button variant="outline" size="icon" title="Xóa lịch sử" aria-label="Xóa lịch sử" onClick={handleClearHistory}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent className="section-content p-0">
            <HistoryList history={history} onOpen={navigateTo} />
          </CardContent>
        </Card>

        <Card className="side-section border-0 bg-transparent shadow-none">
          <CardHeader className="section-header p-0">
            <CardTitle>Nhập link media</CardTitle>
          </CardHeader>
          <CardContent className="section-content p-0">
            <form className="manual-form" onSubmit={handleManualSubmit}>
              <Input
                value={manualUrl}
                onChange={(event) => setManualUrl(event.target.value)}
                type="url"
                placeholder="https://.../movie.m3u8"
              />
              <Button type="submit" variant="secondary">
                <Plus className="h-4 w-4" />
                Thêm
              </Button>
            </form>
          </CardContent>
        </Card>
      </aside>
      {resumePrompt ? <ResumePrompt prompt={resumePrompt} /> : null}
    </main>
  );
}

function SubtitlePicker({ subtitles, selectedSubtitleUrl, onSelect }) {
  if (!subtitles.length) return null;
  const activeLabel = selectedSubtitleUrl === SUBTITLE_OFF
    ? "Tắt"
    : selectedSubtitleUrl === SUBTITLE_AUTO
      ? "Tự động"
      : subtitleDisplayName(subtitles.find((subtitle) => subtitle.url === selectedSubtitleUrl));
  return (
    <div className="subtitle-picker">
      <div className="subtitle-heading">
        <span>Phụ đề</span>
        <Badge variant="secondary">{subtitles.length} track</Badge>
        <span className="subtitle-active">{activeLabel || "Tự động"}</span>
      </div>
      <div className="subtitle-options">
        <Button type="button" size="sm" variant={selectedSubtitleUrl === SUBTITLE_AUTO ? "default" : "outline"} onClick={() => onSelect(SUBTITLE_AUTO)}>
          Tự động
        </Button>
        <Button type="button" size="sm" variant={selectedSubtitleUrl === SUBTITLE_OFF ? "default" : "outline"} onClick={() => onSelect(SUBTITLE_OFF)}>
          Tắt
        </Button>
        {subtitles.map((subtitle) => (
          <Button
            type="button"
            size="sm"
            variant={selectedSubtitleUrl === subtitle.url ? "default" : "outline"}
            key={subtitle.url}
            title={subtitle.url}
            onClick={() => onSelect(subtitle.url)}
          >
            {subtitleDisplayName(subtitle)}
          </Button>
        ))}
      </div>
    </div>
  );
}

function ResumePrompt({ prompt }) {
  const startTime = resumableCurrentTime(prompt.position);
  const title = prompt.position?.title || safeTitle(prompt.candidate);
  const duration = Number(prompt.position?.duration || 0);
  const progressText = duration > 0
    ? `${formatSeconds(startTime)} / ${formatSeconds(duration)}`
    : formatSeconds(startTime);

  return (
    <div className="resume-overlay" role="presentation">
      <div className="resume-dialog" role="dialog" aria-modal="true" aria-labelledby="resume-title">
        <span className="resume-eyebrow">Cast lại link cũ</span>
        <h2 id="resume-title">Tiếp tục xem?</h2>
        <p className="resume-title">{title}</p>
        <p className="resume-copy">
          App đã lưu vị trí dừng ở {progressText}. Chọn cách phát trước khi gửi video lên TV.
        </p>
        <div className="resume-actions">
          <Button type="button" variant="outline" onClick={prompt.onStartOver}>
            <RotateCcw className="h-4 w-4" />
            Phát từ đầu
          </Button>
          <Button type="button" onClick={prompt.onContinue}>
            <Play className="h-4 w-4" />
            Tiếp tục
          </Button>
        </div>
      </div>
    </div>
  );
}

function CandidateCard({ candidate, selected, primary, onSelect, info }) {
  const classification = classifyCandidate(candidate);
  const type = mediaTypeLabel(candidate.contentType, candidate.url);
  return (
    <button
      type="button"
      className={cn("candidate-row", selected && "selected", primary && "primary")}
      data-url={candidate.url}
      onClick={onSelect}
    >
      <span className="min-w-0">
        <span className="row-title">{safeTitle(candidate)}</span>
        <span className="row-meta">
          <Badge variant={classification.kind === "episode" ? "default" : "secondary"}>{classification.label}</Badge>
          <span>{type}</span>
          {candidate.server ? <span>{candidate.server}</span> : null}
          {candidate.episodeName ? <span>{candidate.episodeName}</span> : null}
          <span>{candidate.reason || candidate.source || "Unknown"}</span>
          <span>{hostForUrl(candidate.url)}</span>
        </span>
        <MediaInfoLine info={info} className="row-media" />
        <span className="row-url">{candidate.url}</span>
      </span>
      <span className="select-button" aria-hidden="true">
        {selected ? "✓" : <Plus className="h-4 w-4" />}
      </span>
    </button>
  );
}

function MediaInfoLine({ info, className }) {
  if (!info) return null;
  const durationText = info.live ? "Trực tiếp" : info.durationSec > 0 ? formatSeconds(info.durationSec) : "";
  const resText = resolutionLabel(info.height);
  const dimText = info.width && info.height ? `${info.width}×${info.height}` : "";
  if (!durationText && !resText) return null;
  return (
    <span className={cn("media-info", className)}>
      {durationText ? (
        <span className="media-info-item">
          <Clock className="h-3.5 w-3.5" />
          {durationText}
        </span>
      ) : null}
      {resText ? (
        <span className="media-info-item">
          <MonitorPlay className="h-3.5 w-3.5" />
          {resText}
          {dimText ? <span className="media-info-dim">{dimText}</span> : null}
        </span>
      ) : null}
    </span>
  );
}

function MediaPreview({ candidate, info, onMeta }) {
  const videoRef = useRef(null);
  const [previewStatus, setPreviewStatus] = useState("Đang tải preview");

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !candidate?.url) return undefined;

    let hls = null;
    const url = candidate.url;
    const isHls = mediaTypeLabel(candidate.contentType, candidate.url) === "HLS";
    const meta = { url, durationSec: 0, width: 0, height: 0, live: false, qualities: [] };
    const emit = () => onMeta?.({ ...meta });

    const readVideoSize = () => {
      if (video.videoWidth && video.videoHeight) {
        meta.width = video.videoWidth;
        meta.height = video.videoHeight;
        emit();
      }
    };
    const readDuration = () => {
      const seconds = Number(video.duration);
      if (Number.isFinite(seconds) && seconds > 0) {
        meta.durationSec = seconds;
        meta.live = false;
        emit();
      } else if (seconds === Infinity) {
        meta.live = true;
        emit();
      }
    };
    const handleLoaded = () => {
      setPreviewStatus("Preview đã sẵn sàng");
      readDuration();
      readVideoSize();
    };
    const handleError = () => {
      setPreviewStatus("Không phát preview được, vẫn có thể thử cast.");
    };

    setPreviewStatus("Đang tải preview");
    onMeta?.(null);
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.addEventListener("loadedmetadata", handleLoaded);
    video.addEventListener("loadeddata", readVideoSize);
    video.addEventListener("durationchange", readDuration);
    video.addEventListener("resize", readVideoSize);
    video.addEventListener("error", handleError);

    if (isHls && Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data?.fatal) {
          setPreviewStatus("Không phát preview được, vẫn có thể thử cast.");
        }
      });
      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        const levels = Array.isArray(data?.levels) ? data.levels : [];
        const qualities = levels
          .filter((level) => level && level.height)
          .map((level) => ({ width: level.width || 0, height: level.height || 0 }))
          .sort((a, b) => b.height - a.height);
        if (qualities.length) {
          meta.qualities = qualities;
          if (!meta.height) {
            meta.width = qualities[0].width;
            meta.height = qualities[0].height;
          }
          emit();
        }
      });
      hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
        const details = data?.details;
        if (!details) return;
        if (details.live) {
          meta.live = true;
        } else if (Number.isFinite(details.totalduration) && details.totalduration > 0) {
          meta.durationSec = details.totalduration;
          meta.live = false;
        }
        emit();
      });
      hls.loadSource(candidate.url);
      hls.attachMedia(video);
    } else {
      video.src = candidate.url;
      video.load();
    }

    return () => {
      video.removeEventListener("loadedmetadata", handleLoaded);
      video.removeEventListener("loadeddata", readVideoSize);
      video.removeEventListener("durationchange", readDuration);
      video.removeEventListener("resize", readVideoSize);
      video.removeEventListener("error", handleError);
      if (hls) {
        hls.destroy();
      }
    };
  }, [candidate, onMeta]);

  const previewInfo = info && info.url === candidate.url ? info : null;
  const qualityLabels = previewInfo ? uniqueQualityLabels(previewInfo.qualities) : [];

  return (
    <div className="preview-panel">
      <div className="preview-heading">
        <span className="inline-flex items-center gap-2">
          <Link2 className="h-4 w-4" />
          Preview
        </span>
        <span>{mediaTypeLabel(candidate.contentType, candidate.url)}</span>
      </div>
      <video ref={videoRef} className="preview-video" controls muted playsInline preload="metadata" />
      <p className="preview-status">{previewStatus}</p>
      <MediaInfoLine info={previewInfo} className="preview-meta" />
      {qualityLabels.length > 1 ? (
        <p className="preview-qualities">Chất lượng: {qualityLabels.join(" / ")}</p>
      ) : null}
    </div>
  );
}

function HistoryList({ history, onOpen }) {
  if (!history.length) {
    return <div className="empty-state">Chưa có lịch sử xem.</div>;
  }

  return (
    <div className="history-list">
      {history.slice(0, 8).map((item) => (
        <button type="button" key={item.url} className="history-row" onClick={() => onOpen(item.url)}>
          <span className="min-w-0">
            <span className="row-title">{item.title || hostForUrl(item.url)}</span>
            <span className="row-meta">
              <span>{hostForUrl(item.url)}</span>
              <span>{formatHistoryTime(item.visitedAt)}</span>
            </span>
            <span className="row-url">{item.url}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function formatHistoryTime(value) {
  const date = new Date(Number(value || 0));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit"
  });
}

function DeviceList({ devices, selectedDeviceId, onSelect, scanning }) {
  if (!devices.length) {
    return (
      <div className="empty-state">
        {scanning ? "Đang quét Chromecast trong mạng LAN..." : "Chưa quét Chromecast trong mạng LAN."}
      </div>
    );
  }

  return (
    <div className="device-list">
      {devices.map((device) => {
        const selected = device.id === selectedDeviceId || device.selected;
        const { name, shortId } = splitDeviceLabel(device.name);
        return (
          <button
            type="button"
            key={device.id}
            className={cn("device-row", selected && "selected")}
            data-device-id={device.id}
            onClick={() => onSelect(device.id)}
          >
            <span className="min-w-0">
              <span className="row-title">{name}</span>
              <span className="row-meta">
                <span>{device.host || "LAN"}</span>
                {shortId ? <span className="device-id">ID {shortId.slice(0, 8)}</span> : null}
              </span>
            </span>
            <span className="select-button" aria-hidden="true">{selected ? "✓" : <Plus className="h-4 w-4" />}</span>
          </button>
        );
      })}
    </div>
  );
}

function TvControls({ playback, onControl, onRefresh }) {
  const connected = Boolean(playback?.connected);
  const playing = playback?.playerState === "PLAYING";
  const duration = Number(playback?.duration || 0);
  const baseCurrentTime = Number(playback?.currentTime || 0);
  const syncTime = Number(playback?.updatedAt || Date.now());
  const playbackRate = Number(playback?.playbackRate || 1);
  const receivedVolumeLevel = typeof playback?.volumeLevel === "number" ? Math.round(playback.volumeLevel * 100) : 50;
  const commandMask = Number(playback?.supportedMediaCommands || 0);
  const commandSupport = playback?.commands || {};
  const hasCommandMask = commandMask > 0;
  const canSeek = connected && duration > 0 && (!hasCommandMask || Boolean(commandSupport.seek));
  const canPause = connected && (!playing || !hasCommandMask || Boolean(commandSupport.pause));
  const canSkipForward = connected && (!hasCommandMask ? canSeek : Boolean(commandSupport.skipForward));
  const canSkipBackward = connected && (!hasCommandMask ? canSeek : Boolean(commandSupport.skipBackward));
  const canVolume = connected && (!hasCommandMask || Boolean(commandSupport.streamVolume));
  const canMute = connected && (!hasCommandMask || Boolean(commandSupport.streamMute));
  const queueCount = Array.isArray(playback?.queue) ? playback.queue.length : 0;
  const appText = playback?.activeAppName ? ` - ${playback.activeAppName}` : "";
  const [positionTick, setPositionTick] = useState(Date.now());
  const elapsed = playing && syncTime > 0 ? Math.max(0, (positionTick - syncTime) / 1000) * playbackRate : 0;
  const currentPosition = duration > 0 ? clampNumber(baseCurrentTime + elapsed, 0, duration) : 0;
  const [seekValue, setSeekValue] = useState(currentPosition);
  const [volumeValue, setVolumeValue] = useState(receivedVolumeLevel);
  const [seekEditing, setSeekEditing] = useState(false);
  const [volumeEditing, setVolumeEditing] = useState(false);

  useEffect(() => {
    if (!connected || !playing || seekEditing) {
      setPositionTick(Date.now());
      return undefined;
    }
    const interval = setInterval(() => setPositionTick(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [connected, playing, seekEditing, baseCurrentTime, syncTime]);

  useEffect(() => {
    if (!seekEditing) {
      setSeekValue(currentPosition);
    }
  }, [currentPosition, seekEditing]);

  useEffect(() => {
    if (!volumeEditing) {
      setVolumeValue(receivedVolumeLevel);
    }
  }, [receivedVolumeLevel, volumeEditing]);

  const commitSeek = ([value]) => {
    const nextValue = clampNumber(value, 0, duration > 0 ? duration : 1);
    setSeekValue(nextValue);
    setSeekEditing(false);
    onControl({ action: "seek", currentTime: nextValue });
  };

  const commitVolume = ([value]) => {
    const nextValue = clampNumber(value, 0, 100);
    setVolumeValue(nextValue);
    setVolumeEditing(false);
    onControl({ action: "volume", level: nextValue / 100 });
  };

  return (
    <div className={cn("tv-controls", !connected && "inactive")}>
      <div className="tv-now-playing">
        <div className="min-w-0">
          <p className="tv-now-title">{connected ? playback.title || "Đang cast" : "Chưa có phiên cast"}</p>
          <p className="tv-now-sub">
            {connected ? `${playback.playerState}${appText}${queueCount > 0 ? ` - Hàng đợi ${queueCount}` : ""}` : "Chọn link và bấm Cast video"}
          </p>
        </div>
        <Button type="button" variant="secondary" size="icon" className="shrink-0" title="Cập nhật trạng thái" aria-label="Cập nhật trạng thái" onClick={onRefresh}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <div className="tv-transport">
        <Button type="button" variant="secondary" size="icon" disabled={!canSkipBackward} title="Lùi 10 giây" aria-label="Lùi 10 giây" onClick={() => onControl({ action: "seek-relative", seconds: -10 })}>
          <SkipBack className="h-4 w-4" />
        </Button>
        <Button type="button" className="tv-play" disabled={!canPause} onClick={() => onControl({ action: playing ? "pause" : "play" })}>
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {playing ? "Tạm dừng" : "Phát"}
        </Button>
        <Button type="button" variant="secondary" size="icon" disabled={!canSkipForward} title="Tới 30 giây" aria-label="Tới 30 giây" onClick={() => onControl({ action: "seek-relative", seconds: 30 })}>
          <SkipForward className="h-4 w-4" />
        </Button>
      </div>

      <div className="control-row">
        <div className="control-labels">
          <span>{formatSeconds(seekValue)}</span>
          <span>{duration > 0 ? formatSeconds(duration) : "--:--"}</span>
        </div>
        <Slider
          value={[duration > 0 ? clampNumber(seekValue, 0, duration) : 0]}
          max={duration > 0 ? duration : 1}
          step={1}
          disabled={!canSeek}
          onPointerDown={() => setSeekEditing(true)}
          onValueChange={([value]) => {
            setSeekEditing(true);
            setSeekValue(clampNumber(value, 0, duration > 0 ? duration : 1));
          }}
          onValueCommit={commitSeek}
        />
      </div>

      <Separator />

      <div className="control-row">
        <div className="control-labels">
          <span>Âm lượng</span>
          <span>{playback?.muted ? "Tắt tiếng" : `${volumeValue}%`}</span>
        </div>
        <div className="volume-row">
          <Button
            type="button"
            variant="outline"
            size="icon"
            disabled={!canMute}
            title={playback?.muted ? "Bật tiếng" : "Tắt tiếng"}
            aria-label={playback?.muted ? "Bật tiếng" : "Tắt tiếng"}
            onClick={() => onControl({ action: "mute", muted: !playback?.muted })}
          >
            {playback?.muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </Button>
          <Slider
            value={[clampNumber(volumeValue, 0, 100)]}
            max={100}
            step={1}
            disabled={!canVolume}
            onPointerDown={() => setVolumeEditing(true)}
            onValueChange={([value]) => {
              setVolumeEditing(true);
              setVolumeValue(clampNumber(value, 0, 100));
            }}
            onValueCommit={commitVolume}
          />
        </div>
      </div>
    </div>
  );
}

export default App;
