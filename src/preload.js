const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("movieCast", {
  getAppInfo: () => ipcRenderer.invoke("app-info"),
  updatePage: (payload) => ipcRenderer.invoke("page-updated", payload),
  clearHistory: () => ipcRenderer.invoke("clear-history"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  startDiscovery: () => ipcRenderer.invoke("start-discovery"),
  selectDevice: (deviceId) => ipcRenderer.invoke("select-device", deviceId),
  castMedia: (candidate) => ipcRenderer.invoke("cast-media", candidate),
  joinCastSession: () => ipcRenderer.invoke("join-cast-session"),
  queueMedia: (candidate) => ipcRenderer.invoke("queue-media", candidate),
  getCastStatus: () => ipcRenderer.invoke("cast-status-request"),
  controlCast: (payload) => ipcRenderer.invoke("cast-control", payload),
  stopCast: () => ipcRenderer.invoke("stop-cast"),
  onMediaCandidate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("media-candidate", listener);
    return () => ipcRenderer.removeListener("media-candidate", listener);
  },
  onCastDevices: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("cast-devices", listener);
    return () => ipcRenderer.removeListener("cast-devices", listener);
  },
  onCastStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("cast-status", listener);
    return () => ipcRenderer.removeListener("cast-status", listener);
  },
  onHistoryUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("history-updated", listener);
    return () => ipcRenderer.removeListener("history-updated", listener);
  }
});
