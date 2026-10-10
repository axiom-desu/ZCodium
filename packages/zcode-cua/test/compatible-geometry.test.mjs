/**
 * `compatible/geometry.js` 单测。
 *
 * 覆盖 `.agents/specs/computer-use-wayland-input.md` §5 的已验证矩阵：
 * 元素 frame → 屏幕像素（含窗口移动自洽）、屏幕 → 相对位移、per-output scale。
 * 数值锚点来自本机实测（3200×2000，scale 2）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  elementToScreen,
  findMonitorForPoint,
  frameCenterToScreen,
  rectCenter,
  scaleAt,
  screenToRelativeMotion,
  windowOffset,
} from "../compatible/geometry.js";

const SCALE = 2;

test("静态锚点：计算器 '5' 元素中心 → (398,928)", () => {
  // 真实数据：元素 label="5" frame={x:282,y:517,w:60,h:44}；窗口 (174,104)、buffer (122,58)。
  const point = elementToScreen({
    element: { x: 282, y: 517, w: 60, h: 44 },
    window: { x: 174, y: 104 },
    buffer: { x: 122, y: 58 },
    scale: SCALE,
  });
  assert.deepEqual(point, { x: 398, y: 928 });
});

test("窗口移动后公式自洽：'5' → (1865,1457)", () => {
  const point = elementToScreen({
    element: { x: 1759, y: 1048, w: 40, h: 40 },
    window: { x: 1641, y: 633 },
    buffer: { x: 1589, y: 587 },
    scale: SCALE,
  });
  assert.deepEqual(point, { x: 1865, y: 1457 });
});

test("windowOffset 就是公式里的 'scale×W − B'", () => {
  assert.deepEqual(windowOffset(SCALE, { x: 174, y: 104 }, { x: 122, y: 58 }), {
    x: 226,
    y: 150,
  });
  assert.deepEqual(windowOffset(SCALE, { x: 1641, y: 633 }, { x: 1589, y: 587 }), {
    x: 1693,
    y: 679,
  });
});

test("rectCenter 同时接受 w/h 与 width/height", () => {
  assert.deepEqual(rectCenter({ x: 10, y: 20, w: 40, h: 60 }), { x: 30, y: 50 });
  assert.deepEqual(rectCenter({ x: 10, y: 20, width: 40, height: 60 }), { x: 30, y: 50 });
});

test("frameCenterToScreen 是线性换算", () => {
  assert.deepEqual(frameCenterToScreen({ x: 504, y: 611 }, SCALE, { x: 224, y: 150 }), {
    x: 784,
    y: 1072,
  });
});

test("屏幕 → 相对位移用逻辑单位（除以 scale）", () => {
  assert.deepEqual(screenToRelativeMotion({ x: 400, y: 928 }, { x: 0, y: 0 }, SCALE), {
    dx: 200,
    dy: 464,
  });
  assert.deepEqual(screenToRelativeMotion({ x: 100, y: 100 }, { x: 100, y: 100 }, SCALE), {
    dx: 0,
    dy: 0,
  });
});

test("变 scale：按目标点所在 logical monitor 取 scale", () => {
  const monitors = [
    { x: 0, y: 0, w: 1600, h: 1000, scale: 1 },
    { x: 1600, y: 0, w: 1920, h: 1080, scale: 2 },
  ];
  assert.equal(scaleAt(monitors, { x: 800, y: 500 }), 1);
  assert.equal(scaleAt(monitors, { x: 2000, y: 500 }), 2);
  assert.equal(findMonitorForPoint(monitors, { x: 1599, y: 0 })?.scale, 1);
});

test("目标点不在任何 monitor 内时回退 fallback", () => {
  const monitors = [{ x: 0, y: 0, w: 100, h: 100, scale: 2 }];
  assert.equal(scaleAt(monitors, { x: 500, y: 500 }, 3), 3);
  assert.equal(findMonitorForPoint(monitors, { x: 500, y: 500 }), undefined);
  assert.equal(scaleAt(monitors, { x: 500, y: 500 }), 1);
});

test("非法输入抛 TypeError，不静默产出 NaN", () => {
  assert.throws(() => rectCenter(null), TypeError);
  assert.throws(() => rectCenter({ x: 0, y: 0 }), TypeError);
  assert.throws(() => windowOffset(0, { x: 0, y: 0 }, { x: 0, y: 0 }), TypeError);
  assert.throws(() => screenToRelativeMotion({ x: 0, y: 0 }, { x: 0, y: 0 }, 0), TypeError);
});
