const { app, BrowserWindow } = require("electron");
const { createMainWindow } = require("./window");
const { registerIpcHandlers } = require("./ipc");

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
}

bootstrap();
