const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shm", {
  check: (mapName) => ipcRenderer.invoke("shm:check", mapName),
  getPlatform: () => ipcRenderer.invoke("app:platform"),
});
