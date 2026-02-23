const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shm", {
  check: (mapName) => ipcRenderer.invoke("shm:check", mapName),
  readQuote: (mapName) => ipcRenderer.invoke("shm:readQuote", mapName),
  readQuotes: (mapNames) => ipcRenderer.invoke("shm:readQuotes", mapNames),
  getPlatform: () => ipcRenderer.invoke("app:platform"),
});
