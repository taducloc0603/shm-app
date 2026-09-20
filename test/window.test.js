// Chốt chặn cho các cờ chống throttling.
//
// Vì sao cần test cho mấy dòng cấu hình: chúng VÔ HÌNH khi chạy trên máy bàn. Bỏ đi thì app vẫn
// mở, vẫn ghi log, test khác vẫn xanh — chỉ tới khi chạy trên VPS và ngắt phiên RDP thì vòng poll
// 30 ms ở renderer mới bị Chromium hạ xuống ~1 Hz, và log tick hụt đi trong im lặng.
//
// Bộ test của repo này chạy bằng Node thuần, KHÔNG có node_modules, nên require("electron") sẽ
// không resolve được. Cách duy nhất để nạp được window.js/index.js là vá Module._resolveFilename
// cho riêng tên "electron" rồi cắm một module giả vào require.cache.

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const WINDOW_PATH = require.resolve("../src/main/window.js");

// Ngoài "electron", index.js còn kéo theo configCsvStore -> csv-parse/csv-stringify. Cả ba đều là
// dependency thật chưa cài ở đây, nên stub hết; test không gọi tới chúng, chỉ cần resolve được.
const STUB_PATHS = new Map();
const originalResolve = Module._resolveFilename;

function installStubs(modules) {
  Module._resolveFilename = function (request, ...rest) {
    if (modules[request]) return STUB_PATHS.get(request);
    return originalResolve.call(this, request, ...rest);
  };
  for (const [name, exports] of Object.entries(modules)) {
    const fake = path.join(__dirname, `__stub__${name.replace(/[^a-z0-9]/gi, "_")}.js`);
    STUB_PATHS.set(name, fake);
    require.cache[fake] = { id: fake, filename: fake, loaded: true, exports };
  }
}

function installElectronStub(stub) {
  installStubs({
    electron: stub,
    "csv-parse/sync": { parse: () => [] },
    "csv-stringify/sync": { stringify: () => "" },
  });
}

// Ghi lại options của BrowserWindow mà createMainWindow() truyền vào.
function makeWindowStub() {
  const calls = [];
  class BrowserWindow {
    constructor(options) {
      calls.push(options);
      this.webContents = { openDevTools() {} };
    }
    loadFile() {}
  }
  return { calls, electron: { BrowserWindow } };
}

beforeEach(() => {
  delete require.cache[WINDOW_PATH];
});

afterEach(() => {
  Module._resolveFilename = originalResolve;
  for (const fake of STUB_PATHS.values()) delete require.cache[fake];
  STUB_PATHS.clear();
  delete require.cache[WINDOW_PATH];
});

test("cửa sổ chính tắt backgroundThrottling", () => {
  const { calls, electron } = makeWindowStub();
  installElectronStub(electron);

  require(WINDOW_PATH).createMainWindow();

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].webPreferences.backgroundThrottling,
    false,
    "thiếu backgroundThrottling: false -> ngắt RDP trên VPS sẽ làm log tick hụt trong im lặng"
  );
});

test("các thiết lập cách ly của renderer không bị đổi kèm theo", () => {
  const { calls, electron } = makeWindowStub();
  installElectronStub(electron);

  require(WINDOW_PATH).createMainWindow();

  const { webPreferences } = calls[0];
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.nodeIntegration, false);
  assert.ok(webPreferences.preload.endsWith(path.join("preload", "index.js")));
});

test("main process tắt backgrounding theo đường occlusion, trước whenReady", () => {
  const switches = [];
  let whenReadyCalledAt = null;

  const appStub = {
    commandLine: {
      appendSwitch(name) {
        switches.push(name);
      },
    },
    whenReady() {
      whenReadyCalledAt = switches.length; // số switch đã đăng ký tại thời điểm này
      return { then: () => {} };
    },
    on() {},
    quit() {},
    getPath: () => __dirname,
  };

  const { electron } = makeWindowStub();
  installElectronStub({ ...electron, app: appStub, ipcMain: { handle() {}, on() {} } });

  const indexPath = require.resolve("../src/main/index.js");
  delete require.cache[indexPath];
  for (const dep of ["./ipc", "./csvLogger", "./tickLogger", "./window"]) {
    const resolved = require.resolve(path.join(__dirname, "../src/main", dep));
    delete require.cache[resolved];
  }
  require(indexPath); // bootstrap() chạy ngay khi nạp module

  assert.deepEqual(switches, [
    "disable-background-timer-throttling",
    "disable-renderer-backgrounding",
    "disable-backgrounding-occluded-windows",
  ]);
  assert.equal(whenReadyCalledAt, 3, "switch phải được đăng ký TRƯỚC app.whenReady()");

  delete require.cache[indexPath];
});
