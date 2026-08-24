const { app, BrowserWindow } = require("electron");
const { createMainWindow } = require("./window");
const { registerIpcHandlers } = require("./ipc");
const { endAllCsvSessions } = require("./csvLogger");

function bootstrap() {
  registerIpcHandlers();

  app.whenReady().then(() => {
    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    endAllCsvSessions();
  });
}

bootstrap();
