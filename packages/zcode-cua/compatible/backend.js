/**
 * 兼容层高层后端：把 evdev / geometry 纯函数与 helper 原语组合成 click / hotkey / typeText。
 *
 * 契约见 `.agents/specs/computer-use-wayland-input.md` §6、§7、§8.4。
 *
 * 状态所有权（§7.3）：窗口矩形、光标、截图归 WinRects 扩展；注入 session 归 helper 进程；
 * 元素框/AT-SPI 归 cua-driver。本后端**不缓存**这些状态，每次现取。
 */

import {
  charToKey,
  hotkeySequence,
  isAscii,
  keySequence,
  mouseButtonCode,
  typedKeys,
} from "./evdev.js";
import { scaleAt, screenToRelativeMotion } from "./geometry.js";

const LEFT_SHIFT = 42;
const LEFT_CTRL = 29;
const KEY_U = 22;
const KEY_ENTER = 28;
const VERTICAL_AXIS = 0;
const HORIZONTAL_AXIS = 1;
const DEFAULT_KEY_HOLD_MS = 15;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 目标物理点所在 logical monitor 的 scale（变 scale，§5.6）。
 * monitors 来自 helper 的 `monitors`（逻辑坐标 + scale），先换算成物理边界再命中。
 */
function scaleForPoint(monitors, point, fallback) {
  const physical = (Array.isArray(monitors) ? monitors : []).map((monitor) => ({
    x: monitor.x * monitor.scale,
    y: monitor.y * monitor.scale,
    w: monitor.w * monitor.scale,
    h: monitor.h * monitor.scale,
    scale: monitor.scale,
  }));
  const primary = (monitors ?? []).find((monitor) => monitor.primary);
  return scaleAt(physical, point, primary?.scale ?? fallback);
}

/**
 * @param {object} options
 * @param {{ request: Function }} options.helper helper 客户端端口
 * @param {Function} [options.sleep] 注入的延时（测试用）
 * @param {number} [options.keyHoldMs] 逐键间隔
 */
export function createWaylandInputBackend({
  helper,
  sleep = defaultSleep,
  keyHoldMs = DEFAULT_KEY_HOLD_MS,
} = {}) {
  if (!helper || typeof helper.request !== "function") {
    throw new TypeError("compat backend requires a helper port with request()");
  }

  async function runSequence(sequence) {
    for (const step of sequence) {
      await helper.request("keycode", { code: step.code, pressed: step.state === "down" });
      await sleep(keyHoldMs);
    }
  }

  async function resolveScale(point) {
    const monitors = await helper.request("monitors");
    const primary = monitors.find((monitor) => monitor.primary);
    return scaleForPoint(monitors, point, primary?.scale ?? 1);
  }

  async function moveTo(x, y) {
    const [cursor, monitors] = await Promise.all([
      helper.request("getCursor"),
      helper.request("monitors"),
    ]);
    const primary = monitors.find((monitor) => monitor.primary);
    const scale = scaleForPoint(monitors, { x, y }, primary?.scale ?? 1);
    const { dx, dy } = screenToRelativeMotion({ x, y }, cursor, scale);
    await helper.request("moveRel", { dx, dy });
    return { x, y, scale };
  }

  async function click(x, y, button = "left") {
    const code = mouseButtonCode(button);
    if (code === undefined) throw new Error(`unknown mouse button: ${button}`);
    await moveTo(x, y);
    await helper.request("button", { code, pressed: true });
    await helper.request("button", { code, pressed: false });
  }

  async function button(code, pressed) {
    await helper.request("button", { code, pressed: pressed === true });
  }

  /**
   * 滚轮（discrete）：direction 决定轴向与符号。mutter 约定 axis 0=垂直、1=水平，
   * steps>0 表示下/右，<0 表示上/左，且 steps 不能为 0。滚动按**指针位置**生效。
   */
  async function scroll(direction, amount = 3) {
    const magnitude = Math.abs(Number(amount));
    if (!Number.isFinite(magnitude) || magnitude === 0) {
      throw new Error("scroll amount must be a non-zero number");
    }
    const vertical = direction === "up" || direction === "down";
    const negative = direction === "up" || direction === "left";
    const axis = vertical ? VERTICAL_AXIS : HORIZONTAL_AXIS;
    const steps = negative ? -magnitude : magnitude;
    await helper.request("axisDiscrete", { axis, steps });
    return { axis, steps };
  }

  /** 按住按钮拖动：moveTo(from) → button down → 分步相对移动 → button up。 */
  async function drag(from, to, { button: mouseButton = "left", steps = 12 } = {}) {
    const code = mouseButtonCode(mouseButton);
    if (code === undefined) throw new Error(`unknown mouse button: ${mouseButton}`);
    const monitors = await helper.request("monitors");
    const primary = monitors.find((monitor) => monitor.primary);
    const scale = scaleForPoint(monitors, from, primary?.scale ?? 1);
    let cursor = await helper.request("getCursor");
    const moveToPoint = async (point) => {
      const { dx, dy } = screenToRelativeMotion(point, cursor, scale);
      if (dx !== 0 || dy !== 0) await helper.request("moveRel", { dx, dy });
      cursor = point;
    };
    await moveToPoint(from);
    await helper.request("button", { code, pressed: true });
    const stepCount = Math.max(1, Math.trunc(steps));
    for (let index = 1; index <= stepCount; index += 1) {
      const t = index / stepCount;
      await moveToPoint({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
      await sleep(keyHoldMs);
    }
    await helper.request("button", { code, pressed: false });
    return { steps: stepCount };
  }

  async function keycode(code, pressed) {
    await helper.request("keycode", { code, pressed: pressed === true });
  }

  async function pressKey(key) {
    const sequence = keySequence(key);
    if (!sequence) throw new Error(`unknown key: ${key}`);
    await runSequence(sequence);
  }

  async function hotkey(modifiers, key) {
    await runSequence(hotkeySequence(modifiers, key));
  }

  async function typeAscii(text) {
    const keys = typedKeys(text);
    if (!keys) throw new Error("typeAscii only accepts ASCII text");
    for (const { code, shift } of keys) {
      if (shift) {
        await keycode(LEFT_SHIFT, true);
        await sleep(keyHoldMs);
      }
      await keycode(code, true);
      await keycode(code, false);
      if (shift) await keycode(LEFT_SHIFT, false);
      await sleep(keyHoldMs);
    }
  }

  /**
   * Unicode / UTF-8 码点输入：Linux/GTK 标准的 `Ctrl+Shift+U` + 十六进制 + Enter。
   * 不依赖剪贴板，也不依赖 mutter 听不懂的 Unicode keysym（§6.1）。
   */
  async function typeUnicode(text) {
    for (const char of text) {
      if (char.codePointAt(0) <= 0x7f) {
        await typeAscii(char);
        continue;
      }
      await keycode(LEFT_CTRL, true);
      await keycode(LEFT_SHIFT, true);
      await keycode(KEY_U, true);
      await keycode(KEY_U, false);
      await keycode(LEFT_SHIFT, false);
      await keycode(LEFT_CTRL, false);
      await sleep(keyHoldMs);
      for (const digit of char.codePointAt(0).toString(16)) {
        const spec = charToKey(digit);
        await keycode(spec.code, true);
        await keycode(spec.code, false);
        await sleep(keyHoldMs);
      }
      await keycode(KEY_ENTER, true);
      await keycode(KEY_ENTER, false);
      await sleep(keyHoldMs);
    }
  }

  /**
   * type_text 分级（§6.4）：AT-SPI set_value → ASCII keycode → UTF-8 码点。
   */
  async function typeText(text, { trySetValue } = {}) {
    if (typeof trySetValue === "function" && (await trySetValue(text)) === true) {
      return { level: "set_value" };
    }
    if (isAscii(text)) {
      await typeAscii(text);
      return { level: "keycode" };
    }
    await typeUnicode(text);
    return { level: "codepoint" };
  }

  return {
    listWindows: () => helper.request("listWindows"),
    capture: () => helper.request("capture"),
    getCursor: () => helper.request("getCursor"),
    monitors: () => helper.request("monitors"),
    activate: (windowId) => helper.request("activate", { id: windowId }),
    scaleFor: resolveScale,
    moveTo,
    button,
    keycode,
    click,
    scroll,
    drag,
    pressKey,
    hotkey,
    typeAscii,
    typeUnicode,
    typeText,
    dispose: () => (typeof helper.dispose === "function" ? helper.dispose() : undefined),
  };
}
