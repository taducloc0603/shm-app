const { ipcMain } = require("electron");
const { checkShm, readShmQuote, readShmQuotes } = require("./checkShm");
const { startCsvSession, enqueueCsvRow, endCsvSession } = require("./csvLogger");
const { listConfigs, createConfig } = require("./configCsvStore");

function registerIpcHandlers() {
  ipcMain.handle("app:platform", () => process.platform);
  ipcMain.handle("config:list", async () => listConfigs());
  ipcMain.handle("config:create", async (_event, payload) => createConfig(payload));
  ipcMain.handle("shm:check", async (_event, mapName) => checkShm(mapName));
  ipcMain.handle("shm:readQuote", async (_event, mapName) => readShmQuote(mapName));
  ipcMain.handle("shm:readQuotes", async (_event, mapNames) => readShmQuotes(mapNames));
  ipcMain.handle("csv:startSession", async (_event, startTimestamp) => startCsvSession(startTimestamp));
  ipcMain.handle("csv:enqueueRow", async (_event, sessionId, row) => enqueueCsvRow(sessionId, row));
  ipcMain.handle("csv:endSession", async (_event, sessionId) => endCsvSession(sessionId));
}

module.exports = { registerIpcHandlers };
