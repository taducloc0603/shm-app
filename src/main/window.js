const { BrowserWindow } = require("electron");
const path = require("path");

function createMainWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "../preload/index.js"),
    },
  });

  win.loadFile(path.join(__dirname, "../renderer/index.html"));
  // win.webContents.openDevTools();
  return win;
}

module.exports = { createMainWindow };
