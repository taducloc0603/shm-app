const { ipcMain } = require("electron");
const { checkShm, readShmQuote, readShmQuotes } = require("./checkShm");

function registerIpcHandlers() {
  ipcMain.handle("app:platform", () => process.platform);
  ipcMain.handle("shm:check", async (_event, mapName) => checkShm(mapName));
  ipcMain.handle("shm:readQuote", async (_event, mapName) => readShmQuote(mapName));
  ipcMain.handle("shm:readQuotes", async (_event, mapNames) => readShmQuotes(mapNames));
}

module.exports = { registerIpcHandlers };
