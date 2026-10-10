#!/usr/bin/env -S gjs
/**
 * 兼容层长驻 helper（GJS）。
 *
 * 契约见 `.agents/specs/computer-use-wayland-input.md` §3、§4、§8.3。
 *
 * 为什么是独立 GJS 进程（决策 C）：
 *   - mutter 的 RemoteDesktop session 绑定在 **D-Bus 连接**上，连接断开即失效，
 *     所以必须长驻；
 *   - GNOME 自带 gjs 与 `Gio.DBus`，无需给 Node 引入 D-Bus 依赖。
 *
 * 职责边界：本文件**只代理 D-Bus 原语**（WinRects 读、mutter 注入、DisplayConfig 几何）。
 * 坐标换算、hotkey 组装、type_text 分级等高层逻辑在 Node `compatible/backend.js`。
 *
 * 协议：stdin/stdout JSON-lines。请求 `{id, method, params}`，
 * 响应 `{id, ok:true, result}` 或 `{id, ok:false, error}`，启动时先发 `{event:"ready"}`。
 */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const WIRECTS_DEST = "org.cua.WinRects";
const WIRECTS_PATH = "/org/cua/WinRects";
const WIRECTS_IFACE = "org.cua.WinRects";

const MUTTER_DEST = "org.gnome.Mutter.RemoteDesktop";
const MUTTER_PATH = "/org/gnome/Mutter/RemoteDesktop";
const MUTTER_IFACE = "org.gnome.Mutter.RemoteDesktop";
const SESSION_IFACE = "org.gnome.Mutter.RemoteDesktop.Session";

const DISPLAYCONFIG_DEST = "org.gnome.Mutter.DisplayConfig";
const DISPLAYCONFIG_PATH = "/org/gnome/Mutter/DisplayConfig";
const DISPLAYCONFIG_IFACE = "org.gnome.Mutter.DisplayConfig";

const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
const stdout = Gio.UnixOutputStream.new(1, false);
const stdin = Gio.DataInputStream.new(Gio.UnixInputStream.new(0, false));
const loop = GLib.MainLoop.new(null, false);

let sessionPath = null;
let shuttingDown = false;

function write(message) {
  stdout.write_all(JSON.stringify(message) + "\n", null);
  stdout.flush(null);
}

function dbus(dest, path, iface, method, params) {
  return bus.call_sync(dest, path, iface, method, params, null, Gio.DBusCallFlags.NONE, -1, null);
}

function winrects(method, params) {
  return dbus(WIRECTS_DEST, WIRECTS_PATH, WIRECTS_IFACE, method, params);
}

/** 首个注入调用时建 mutter session；读操作不需要它。 */
function ensureSession() {
  if (sessionPath) return sessionPath;
  const reply = dbus(MUTTER_DEST, MUTTER_PATH, MUTTER_IFACE, "CreateSession", null);
  sessionPath = reply.deep_unpack()[0];
  dbus(MUTTER_DEST, sessionPath, SESSION_IFACE, "Start", null);
  return sessionPath;
}

function session(method, params) {
  ensureSession();
  return dbus(MUTTER_DEST, sessionPath, SESSION_IFACE, method, params);
}

/**
 * logical monitor → `{x, y, w, h, scale, primary}`（逻辑单位，供 Node 的 scaleAt 使用）。
 * DisplayConfig 只给 mode 像素与 scale，尺寸需自行除，并按 transform 交换宽高。
 */
function logicalMonitors() {
  const reply = dbus(
    DISPLAYCONFIG_DEST,
    DISPLAYCONFIG_PATH,
    DISPLAYCONFIG_IFACE,
    "GetCurrentState",
    null,
  );
  const [, monitors, logical] = reply.deep_unpack();
  const modesByConnector = new Map();
  for (const entry of monitors) modesByConnector.set(entry[0][0], entry[1]);
  return logical.map((entry) => {
    const [x, y, scale, transform, primary, lmMonitors] = entry;
    const swapped = transform % 2 === 1;
    let w = 0;
    let h = 0;
    for (const connected of lmMonitors) {
      const modes = modesByConnector.get(connected[0]) ?? [];
      const current =
        modes.find((mode) => mode[6] && mode[6]["is-current"]) ??
        modes.find((mode) => mode[6] && mode[6]["is-preferred"]) ??
        modes[0];
      if (!current) continue;
      const mw = current[1] / scale;
      const mh = current[2] / scale;
      w = Math.max(w, swapped ? mh : mw);
      h = Math.max(h, swapped ? mw : mh);
    }
    return { x, y, w, h, scale, primary, transform };
  });
}

function capture() {
  const pngBase64 = winrects("Capture", null).deep_unpack()[0];
  const monitors = logicalMonitors();
  const main = monitors.find((monitor) => monitor.primary) ??
    monitors[0] ?? { w: 0, h: 0, scale: 1 };
  return {
    pngBase64,
    width: Math.round(main.w * main.scale),
    height: Math.round(main.h * main.scale),
  };
}

const methods = {
  ping: () => ({ ok: true }),
  version: () => winrects("GetVersion", null).deep_unpack()[0],
  listWindows: () => JSON.parse(winrects("GetRects", null).deep_unpack()[0]),
  getCursor: () => {
    const [x, y] = winrects("GetCursor", null).deep_unpack();
    return { x, y };
  },
  activate: (params) => {
    const reply = winrects("Activate", new GLib.Variant("(u)", [params.id]));
    return reply.deep_unpack()[0];
  },
  capture,
  monitors: logicalMonitors,
  moveRel: (params) => {
    session("NotifyPointerMotionRelative", new GLib.Variant("(dd)", [params.dx, params.dy]));
    return { ok: true };
  },
  button: (params) => {
    session(
      "NotifyPointerButton",
      new GLib.Variant("(ib)", [params.code, params.pressed === true]),
    );
    return { ok: true };
  },
  keycode: (params) => {
    session(
      "NotifyKeyboardKeycode",
      new GLib.Variant("(ub)", [params.code, params.pressed === true]),
    );
    return { ok: true };
  },
  keysym: (params) => {
    session(
      "NotifyKeyboardKeysym",
      new GLib.Variant("(ub)", [params.code, params.pressed === true]),
    );
    return { ok: true };
  },
  // 滚轮：axis 0=垂直（steps>0 向下），1=水平（steps>0 向右）；steps 不能为 0。
  axisDiscrete: (params) => {
    session("NotifyPointerAxisDiscrete", new GLib.Variant("(ui)", [params.axis, params.steps]));
    return { ok: true };
  },
  // 连续滚动：flags 位 WHEEL=2 / FINGER=4 / CONTINUOUS=8，默认 0=FINGER。
  axis: (params) => {
    session(
      "NotifyPointerAxis",
      new GLib.Variant("(ddu)", [params.dx, params.dy, params.flags ?? 0]),
    );
    return { ok: true };
  },
};

function handle(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    write({ id: null, ok: false, error: "invalid json request" });
    return;
  }
  const { id, method, params } = request;
  if (method === "shutdown") {
    write({ id, ok: true, result: { ok: true } });
    shuttingDown = true;
    loop.quit();
    return;
  }
  const handler = methods[method];
  if (!handler) {
    write({ id, ok: false, error: `unknown method: ${method}` });
    return;
  }
  try {
    write({ id, ok: true, result: handler(params ?? {}) });
  } catch (error) {
    write({ id, ok: false, error: String(error && error.message ? error.message : error) });
  }
}

function readNext() {
  stdin.read_line_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
    let line = null;
    try {
      [line] = source.read_line_finish_utf8(result);
    } catch {
      loop.quit();
      return;
    }
    if (line === null) {
      loop.quit();
      return;
    }
    handle(line);
    if (!shuttingDown) readNext();
  });
}

try {
  write({ event: "ready", version: methods.version() });
} catch (error) {
  write({
    event: "ready",
    version: null,
    error: String(error && error.message ? error.message : error),
  });
}
readNext();
loop.run();
