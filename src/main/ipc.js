const { ipcMain } = require("electron");
const { checkShm } = require("./checkShm");

function registerIpcHandlers() {
  ipcMain.handle("app:platform", () => process.platform);
  ipcMain.handle("shm:check", async (_event, mapName) => checkShm(mapName));
}

module.exports = { registerIpcHandlers };
