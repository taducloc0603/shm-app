const { app, BrowserWindow, dialog } = require("electron");
const { createMainWindow } = require("./window");
const { registerIpcHandlers } = require("./ipc");
const { endAllCsvSessions } = require("./csvLogger");

const APP_EXPIRE_AT = new Date(2026, 3, 30, 23, 59, 59, 999).getTime();

function isAppExpired(nowMs = Date.now()) {
  return Number(nowMs) > APP_EXPIRE_AT;
}

function showExpiredAndQuit() {
  dialog.showErrorBox(
    "Ứng dụng đã hết hạn",
    "Vui lòng liên hệ quản trị viên để gia hạn."
  );
  app.quit();
}

function bootstrap() {
  registerIpcHandlers();

  app.whenReady().then(() => {
    if (isAppExpired()) {
      showExpiredAndQuit();
      return;
    }

    createMainWindow();

    app.on("activate", () => {
      if (isAppExpired()) {
        showExpiredAndQuit();
        return;
      }

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
