const { app, BrowserWindow } = require("electron");
const { createMainWindow } = require("./window");
const { registerIpcHandlers } = require("./ipc");
const { endAllCsvSessions } = require("./csvLogger");
const { getDefaultTickLogger } = require("./tickLogger");

let tickLogsClosed = false;

function bootstrap() {
  // backgroundThrottling: false (window.js) lo phần "trang chạy nền". Ba switch dưới đây lo đường
  // OCCLUSION - cửa sổ bị che hẳn, đúng tình huống ngắt phiên RDP trên VPS - vốn là cơ chế khác
  // của Chromium. Phải gọi TRƯỚC app.whenReady().
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

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

  app.on("before-quit", (event) => {
    endAllCsvSessions();

    // Đợi file tick ghi nốt hàng đợi + footer (tối đa 5 s) rồi mới thoát, tránh mất dòng cuối.
    if (tickLogsClosed) return;
    event.preventDefault();
    getDefaultTickLogger()
      .endAllSessions()
      .catch((err) => console.error("Đóng file tick lỗi:", err))
      .finally(() => {
        tickLogsClosed = true;
        app.quit();
      });
  });
}

bootstrap();
