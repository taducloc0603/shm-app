const { app, BrowserWindow } = require("electron");
const { createMainWindow } = require("./window");
const { registerIpcHandlers } = require("./ipc");
const { endAllCsvSessions } = require("./csvLogger");
const { getDefaultTickLogger } = require("./tickLogger");

let tickLogsClosed = false;

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
