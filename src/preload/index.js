const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shm", {
  listConfigs: () => ipcRenderer.invoke("config:list"),
  createConfig: (payload) => ipcRenderer.invoke("config:create", payload),
  check: (mapName) => ipcRenderer.invoke("shm:check", mapName),
  readQuote: (mapName) => ipcRenderer.invoke("shm:readQuote", mapName),
  readQuotes: (mapNames) => ipcRenderer.invoke("shm:readQuotes", mapNames),
  scan: (prefix) => ipcRenderer.invoke("shm:scan", prefix),
  startCsvSession: (startTimestamp) => ipcRenderer.invoke("csv:startSession", startTimestamp),
  enqueueCsvRow: (sessionId, row) => ipcRenderer.invoke("csv:enqueueRow", sessionId, row),
  endCsvSession: (sessionId) => ipcRenderer.invoke("csv:endSession", sessionId),
  getPlatform: () => ipcRenderer.invoke("app:platform"),
});
