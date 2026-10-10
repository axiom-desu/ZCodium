/**
 * evdev 键码与字符映射（纯函数）。
 *
 * 兼容层契约见 `.agents/specs/computer-use-wayland-input.md` §6。
 * `org.gnome.Mutter.RemoteDesktop.Session` 的 `NotifyKeyboardKeycode` 与
 * `NotifyPointerButton` 使用 Linux evdev 码，不是 X11 keycode：
 *   - 左键是 `BTN_LEFT = 272`（早期误用 `1`，被 `translate_to_clutter_button` 翻成非法键）；
 *   - 字母 V 是 `47`（写成 `53`=斜杠会让 Ctrl+V 变成 Ctrl+/）。
 *
 * 低层 `resolveKey` / `charToKey` 对未知输入返回 `undefined`；
 * 组合器 `keySequence` / `hotkeySequence` / `typedKeys` 返回 `undefined` 或抛错，由后端决定降级。
 */

const LETTERS = Object.freeze({
  q: 16,
  w: 17,
  e: 18,
  r: 19,
  t: 20,
  y: 21,
  u: 22,
  i: 23,
  o: 24,
  p: 25,
  a: 30,
  s: 31,
  d: 32,
  f: 33,
  g: 34,
  h: 35,
  j: 36,
  k: 37,
  l: 38,
  z: 44,
  x: 45,
  c: 46,
  v: 47,
  b: 48,
  n: 49,
  m: 50,
});

const DIGITS = Object.freeze({
  1: 2,
  2: 3,
  3: 4,
  4: 5,
  5: 6,
  6: 7,
  7: 8,
  8: 9,
  9: 10,
  0: 11,
});

const SHIFTED_DIGITS = Object.freeze({
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
});

/** 未按 Shift 的标点 → evdev 名；按 Shift 的标点 → `{ shift: 名 }`。 */
const PUNCTUATION = Object.freeze({
  "-": "minus",
  _: { shift: "minus" },
  "=": "equal",
  "+": { shift: "equal" },
  "[": "bracketleft",
  "{": { shift: "bracketleft" },
  "]": "bracketright",
  "}": { shift: "bracketright" },
  ";": "semicolon",
  ":": { shift: "semicolon" },
  "'": "apostrophe",
  '"': { shift: "apostrophe" },
  "`": "grave",
  "~": { shift: "grave" },
  "\\": "backslash",
  "|": { shift: "backslash" },
  ",": "comma",
  "<": { shift: "comma" },
  ".": "dot",
  ">": { shift: "dot" },
  "/": "slash",
  "?": { shift: "slash" },
  " ": "space",
  "\n": "enter",
  "\t": "tab",
});

const NAMED_KEYS = Object.freeze({
  escape: 1,
  esc: 1,
  enter: 28,
  return: 28,
  tab: 15,
  backspace: 14,
  delete: 111,
  space: 57,
  capslock: 58,
  minus: 12,
  equal: 13,
  comma: 51,
  dot: 52,
  period: 52,
  slash: 53,
  backslash: 43,
  semicolon: 39,
  apostrophe: 40,
  grave: 41,
  bracketleft: 26,
  bracketright: 27,
  leftctrl: 29,
  leftcontrol: 29,
  rightctrl: 97,
  leftshift: 42,
  rightshift: 54,
  leftalt: 56,
  rightalt: 100,
  leftmeta: 125,
  leftsuper: 125,
  home: 102,
  end: 107,
  insert: 110,
  pageup: 104,
  pagedown: 109,
  up: 103,
  down: 108,
  left: 105,
  right: 106,
  f1: 59,
  f2: 60,
  f3: 61,
  f4: 62,
  f5: 63,
  f6: 64,
  f7: 65,
  f8: 66,
  f9: 67,
  f10: 68,
  f11: 87,
  f12: 88,
});

/** 键名/字符 → evdev 码（未平铺修饰键语义，仅码值）。 */
export const EVDEV_CODES = Object.freeze({ ...NAMED_KEYS, ...LETTERS, ...DIGITS });

/** 鼠标键名 → evdev 码。 */
export const MOUSE_BUTTONS = Object.freeze({ left: 272, right: 273, middle: 274 });

const MODIFIER_ALIASES = Object.freeze({
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  super: "super",
  meta: "super",
  cmd: "super",
  command: "super",
  win: "super",
});

/** 修饰键 canonical 名 → evdev 码（用左键变体）。 */
const MODIFIER_CODES = Object.freeze({ ctrl: 29, shift: 42, alt: 56, super: 125 });

/** 全部为 ASCII（含控制字符）时为真。用于 type_text 分级路由。 */
export function isAscii(text) {
  if (typeof text !== "string") return false;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

/** 鼠标键名 → evdev 码；未知返回 `undefined`。 */
export function mouseButtonCode(name) {
  if (typeof name !== "string") return undefined;
  return MOUSE_BUTTONS[name.toLowerCase()];
}

/** 修饰键名（含别名）→ `{ name, code }`；未知返回 `undefined`。 */
export function resolveModifier(name) {
  if (typeof name !== "string") return undefined;
  const canonical = MODIFIER_ALIASES[name.toLowerCase()];
  if (!canonical) return undefined;
  return { name: canonical, code: MODIFIER_CODES[canonical] };
}

/** 键名或单字符 → evdev 码；未知返回 `undefined`。 */
export function resolveKey(name) {
  const spec = resolveKeySpec(name);
  return spec?.code;
}

/** 单字符 → `{ code, shift }`；未知（含非 ASCII）返回 `undefined`。 */
export function charToKey(char) {
  if (typeof char !== "string" || char.length !== 1) return undefined;
  const lower = char.toLowerCase();
  if (LETTERS[lower] !== undefined) return { code: LETTERS[lower], shift: char !== lower };
  if (DIGITS[char] !== undefined) return { code: DIGITS[char], shift: false };
  if (SHIFTED_DIGITS[char] !== undefined) {
    return { code: DIGITS[SHIFTED_DIGITS[char]], shift: true };
  }
  const punct = PUNCTUATION[char];
  if (typeof punct === "string") return { code: NAMED_KEYS[punct], shift: false };
  if (punct && typeof punct === "object") return { code: NAMED_KEYS[punct.shift], shift: true };
  return undefined;
}

/** 单个按键的 down→up 序列（大写/Shift 字符自动包 Shift）；未知返回 `undefined`。 */
export function keySequence(name) {
  const spec = resolveKeySpec(name);
  if (!spec) return undefined;
  const sequence = [];
  if (spec.shift) sequence.push({ code: MODIFIER_CODES.shift, state: "down" });
  sequence.push({ code: spec.code, state: "down" });
  sequence.push({ code: spec.code, state: "up" });
  if (spec.shift) sequence.push({ code: MODIFIER_CODES.shift, state: "up" });
  return sequence;
}

/**
 * `hotkey(mods, key)` 的按键序列：down(mods) → tap(key) → up(mods 逆序)。
 * 例：`hotkey(['ctrl','shift'], 't')` → `d29,d42,d20,u20,u42,u29`。
 * 未知修饰键/键抛 `Error`。
 */
export function hotkeySequence(modifiers, key) {
  const mods = (Array.isArray(modifiers) ? modifiers : []).map((name) => {
    const resolved = resolveModifier(name);
    if (!resolved) throw new Error(`unknown modifier: ${name}`);
    return resolved;
  });
  const target = resolveKeySpec(key);
  if (!target) throw new Error(`unknown key: ${key}`);
  const hasShift = mods.some((mod) => mod.name === "shift");
  const downMods =
    target.shift && !hasShift ? [...mods, { name: "shift", code: MODIFIER_CODES.shift }] : mods;
  const sequence = [];
  for (const mod of downMods) sequence.push({ code: mod.code, state: "down" });
  sequence.push({ code: target.code, state: "down" });
  sequence.push({ code: target.code, state: "up" });
  for (const mod of [...downMods].reverse()) sequence.push({ code: mod.code, state: "up" });
  return sequence;
}

/** 整段 ASCII 文本 → 逐字符 `{ code, shift }` 列表；含非 ASCII 或未知字符返回 `undefined`。 */
export function typedKeys(text) {
  if (!isAscii(text)) return undefined;
  const keys = [];
  for (const char of text) {
    const spec = charToKey(char);
    if (!spec) return undefined;
    keys.push(spec);
  }
  return keys;
}

function resolveKeySpec(key) {
  if (typeof key !== "string" || key.length === 0) return undefined;
  if (key.length === 1) {
    const char = charToKey(key);
    if (char) return char;
  }
  const code = NAMED_KEYS[key.toLowerCase()];
  return code === undefined ? undefined : { code, shift: false };
}
