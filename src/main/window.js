const { BrowserWindow } = require("electron");
const path = require("path");

function createMainWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Vòng poll shared memory 30 ms nằm ở renderer (app.js). Chromium mặc định hạ timer của
      // trang xuống ~1 Hz khi trang chạy nền; trên VPS qua RDP (ngắt kết nối, thu nhỏ cửa sổ)
      // điều đó làm log tick tụt thầm lặng từ ~33 còn ~1 mẫu/giây mà KHÔNG báo lỗi gì.
      // Đừng bỏ dòng này. Kiểm chứng bằng cột "độ phủ" của tools/ticks.mjs stats.
      backgroundThrottling: false,
      preload: path.join(__dirname, "../preload/index.js"),
    },
  });

  win.loadFile(path.join(__dirname, "../renderer/index.html"));
  // win.webContents.openDevTools();
  return win;
}

module.exports = { createMainWindow };
