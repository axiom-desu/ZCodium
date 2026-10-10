/* eslint-disable no-unused-vars -- GNOME legacy 扩展入口：init() 由 Shell 调用，catch 变量仅占位。 */
/*
 * cua WinRects — GNOME 42–44 legacy port（仓库副本，由 install-extension.mjs 安装）。
 *
 * cua-driver 的原生 helper（winrects@cua）使用 GNOME 45+ 的 ESM 扩展 API，
 * GNOME 42–44 无法加载。本文件用 legacy 扩展 API（imports.gi.* / function init()）
 * 实现同一套 D-Bus 接口 org.cua.WinRects，语义与官方扩展一致：
 *
 *   GetVersion() -> uint         版本号（cua-driver / ZCode 校验）
 *   GetRects() -> json           每个窗口的 frame 几何、buffer 原点、焦点、可见性
 *   GetCursor() -> (i x, i y)    shell 内部真实指针位置（Wayland 客户端读不到）
 *   Activate(id) -> bool         激活 stable-sequence 窗口并确认焦点
 *   Capture() -> png_base64      通过 Shell.Screenshot 抓取整个舞台
 *   MoveCursor/ClickPulse/HideCursor/SetCursorColor/SetCursorState/SetSessionLabel
 *                               agent 光标叠加，本端口为 no-op（cua-driver best-effort 使用）
 *
 * 只服务本机 cua-driver；不写入任何状态，不做输入合成。
 */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Shell = imports.gi.Shell;

const IFACE = `<node><interface name="org.cua.WinRects">
<method name="GetVersion"><arg type="u" direction="out" name="version"/></method>
<method name="GetRects"><arg type="s" direction="out" name="json"/></method>
<method name="GetCursor"><arg type="i" direction="out" name="x"/><arg type="i" direction="out" name="y"/></method>
<method name="Capture"><arg type="s" direction="out" name="png_base64"/></method>
<method name="Activate"><arg type="u" direction="in" name="id"/><arg type="b" direction="out" name="activated"/></method>
<method name="MoveCursor"><arg type="i" direction="in" name="x"/><arg type="i" direction="in" name="y"/></method>
<method name="ClickPulse"><arg type="i" direction="in" name="x"/><arg type="i" direction="in" name="y"/></method>
<method name="SetCursorColor"><arg type="s" direction="in" name="fill_color"/></method>
<method name="SetCursorState"><arg type="s" direction="in" name="action"/><arg type="s" direction="in" name="delivery"/><arg type="s" direction="in" name="target"/><arg type="b" direction="in" name="active"/></method>
<method name="SetSessionLabel"><arg type="s" direction="in" name="label"/></method>
<method name="HideCursor"></method>
</interface></node>`;

// Shell.Screenshot.screenshot(include_cursor, stream, callback) + screenshot_finish。
Gio._promisify(Shell.Screenshot.prototype, "screenshot");

class CuaWinRects {
  enable() {
    this._impl = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
    this._impl.export(Gio.DBus.session, "/org/cua/WinRects");
    this._nameId = Gio.bus_own_name(
      Gio.BusType.SESSION,
      "org.cua.WinRects",
      Gio.BusNameOwnerFlags.REPLACE,
      null,
      null,
      null,
    );
  }

  disable() {
    if (this._impl) {
      this._impl.unexport();
      this._impl = null;
    }
    if (this._nameId) {
      Gio.bus_unown_name(this._nameId);
      this._nameId = 0;
    }
  }

  GetVersion() {
    return 8;
  }

  GetCursor() {
    const [x, y] = global.get_pointer();
    return [x, y];
  }

  GetRects() {
    const actors = global.get_window_actors();
    const actorByWindow = new Map();
    for (const actor of actors) {
      if (actor && actor.meta_window) actorByWindow.set(actor.meta_window, actor);
    }
    const windows = global.display.sort_windows_by_stacking([...actorByWindow.keys()]);
    const focusedWindow = global.display.focus_window;
    const out = [];
    for (let stacking = 0; stacking < windows.length; stacking++) {
      const window = windows[stacking];
      const actor = actorByWindow.get(window);
      const frame = window.get_frame_rect();
      // get_buffer_rect 在旧版 Shell 上可能缺失；缺失时退回 frame。
      let buffer = frame;
      try {
        buffer = window.get_buffer_rect();
      } catch (_error) {
        buffer = frame;
      }
      const minimized = Boolean(window.minimized);
      out.push({
        id: window.get_stable_sequence(),
        pid: window.get_pid(),
        title: window.get_title() || "",
        x: frame.x,
        y: frame.y,
        w: frame.width,
        h: frame.height,
        buffer_x: buffer.x,
        buffer_y: buffer.y,
        focused: focusedWindow === window,
        minimized,
        visible: Boolean(actor && actor.visible) && !minimized,
        stacking,
      });
    }
    return JSON.stringify(out);
  }

  async CaptureAsync(_params, invocation) {
    try {
      const shooter = new Shell.Screenshot();
      const stream = Gio.MemoryOutputStream.new_resizable();
      // 不包含真实光标：cua-driver 自己绘制 agent 光标，且远程/无头指针座的
      // cursor sprite 可能是 0x0，Shell 的 stage-content 捕获会因此崩溃。
      await shooter.screenshot(false, stream);
      stream.close(null);
      const raw = stream.steal_as_bytes().get_data();
      const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
      const encoded = GLib.base64_encode(bytes);
      invocation.return_value(new GLib.Variant("(s)", [encoded]));
    } catch (error) {
      invocation.return_dbus_error("org.cua.WinRects.CaptureFailed", String(error));
    }
  }

  ActivateAsync(params, invocation) {
    const id = params[0];
    const target = global
      .get_window_actors()
      .map((actor) => actor && actor.meta_window)
      .find((window) => window && window.get_stable_sequence() === id);
    if (!target) {
      invocation.return_value(new GLib.Variant("(b)", [false]));
      return;
    }
    target.activate(global.get_current_time());
    // 100ms 后回报焦点是否真的落到目标窗口；cua-driver 只在 true 时才发输入。
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
      invocation.return_value(new GLib.Variant("(b)", [global.display.focus_window === target]));
      return GLib.SOURCE_REMOVE;
    });
  }

  // agent 光标叠加：cua-driver 按 best-effort 调用，缺失即不回执。
  MoveCursor() {}
  ClickPulse() {}
  HideCursor() {}
  SetCursorColor() {}
  SetCursorState() {}
  SetSessionLabel() {}
}

function init() {
  return new CuaWinRects();
}
