/**
 * `compatible/evdev.js` 单测。
 *
 * 覆盖 `.agents/specs/computer-use-wayland-input.md` §6 的键位契约与踩坑：
 * 左键 272、V=47、Shift 包裹、hotkey 的 down/tap/up 顺序、非 ASCII 的降级边界。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  charToKey,
  hotkeySequence,
  isAscii,
  keySequence,
  mouseButtonCode,
  resolveKey,
  resolveModifier,
  typedKeys,
} from "../compatible/evdev.js";

test("鼠标键用 evdev 码：左键 272，不是 1", () => {
  assert.equal(mouseButtonCode("left"), 272);
  assert.equal(mouseButtonCode("Right"), 273);
  assert.equal(mouseButtonCode("middle"), 274);
  assert.equal(mouseButtonCode("nope"), undefined);
});

test("字母 V 是 47（写成 53 会让 Ctrl+V 变 Ctrl+/）", () => {
  assert.equal(resolveKey("v"), 47);
  assert.equal(resolveKey("V"), 47);
  assert.equal(charToKey("v").code, 47);
  assert.equal(resolveKey("slash"), 53);
});

test("字符 → 键位：大小写与 Shift 标点", () => {
  assert.deepEqual(charToKey("a"), { code: 30, shift: false });
  assert.deepEqual(charToKey("A"), { code: 30, shift: true });
  assert.deepEqual(charToKey("!"), { code: 2, shift: true });
  assert.deepEqual(charToKey("+"), { code: 13, shift: true });
  assert.deepEqual(charToKey("="), { code: 13, shift: false });
  assert.deepEqual(charToKey(" "), { code: 57, shift: false });
  assert.deepEqual(charToKey("\n"), { code: 28, shift: false });
});

test("非 ASCII 字符没有 evdev 键位（走 set_value / 剪贴板）", () => {
  assert.equal(charToKey("π"), undefined);
  assert.equal(charToKey("你"), undefined);
  assert.equal(charToKey("😀"), undefined);
  assert.equal(typedKeys("你好"), undefined);
  assert.equal(isAscii("hello 123!@#"), true);
  assert.equal(isAscii("hi π"), false);
});

test("keySequence 对大写/Shift 字符自动包 Shift", () => {
  assert.deepEqual(keySequence("A"), [
    { code: 42, state: "down" },
    { code: 30, state: "down" },
    { code: 30, state: "up" },
    { code: 42, state: "up" },
  ]);
  assert.deepEqual(keySequence("enter"), [
    { code: 28, state: "down" },
    { code: 28, state: "up" },
  ]);
  assert.equal(keySequence("π"), undefined);
});

test("hotkey 顺序是 down(mods) → tap(key) → up(mods 逆序)", () => {
  assert.deepEqual(hotkeySequence(["ctrl"], "v"), [
    { code: 29, state: "down" },
    { code: 47, state: "down" },
    { code: 47, state: "up" },
    { code: 29, state: "up" },
  ]);
  assert.deepEqual(hotkeySequence(["ctrl", "shift"], "t"), [
    { code: 29, state: "down" },
    { code: 42, state: "down" },
    { code: 20, state: "down" },
    { code: 20, state: "up" },
    { code: 42, state: "up" },
    { code: 29, state: "up" },
  ]);
});

test("hotkey 对 Shift 字符不重复按 Shift", () => {
  assert.deepEqual(
    hotkeySequence(["ctrl"], "A").map((step) => step.code),
    [29, 42, 30, 30, 42, 29],
  );
});

test("hotkey 对未知修饰键/键抛错", () => {
  assert.throws(() => hotkeySequence(["hyper"], "v"), /unknown modifier/);
  assert.throws(() => hotkeySequence(["ctrl"], "π"), /unknown key/);
});

test("修饰键别名归一", () => {
  assert.deepEqual(resolveModifier("Control"), { name: "ctrl", code: 29 });
  assert.deepEqual(resolveModifier("cmd"), { name: "super", code: 125 });
  assert.deepEqual(resolveModifier("Option"), { name: "alt", code: 56 });
  assert.equal(resolveModifier("hyper"), undefined);
});

test("typedKeys 展开整段 ASCII", () => {
  assert.deepEqual(typedKeys("aA!"), [
    { code: 30, shift: false },
    { code: 30, shift: true },
    { code: 2, shift: true },
  ]);
  assert.deepEqual(typedKeys(""), []);
});
