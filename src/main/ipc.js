const { ipcMain } = require("electron");
const { checkShm, readShmQuote } = require("./checkShm");

function registerIpcHandlers() {
  ipcMain.handle("app:platform", () => process.platform);
  ipcMain.handle("shm:check", async (_event, mapName) => checkShm(mapName));
  ipcMain.handle("shm:readQuote", async (_event, mapName) => readShmQuote(mapName));
}

module.exports = { registerIpcHandlers };
