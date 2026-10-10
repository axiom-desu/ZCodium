/**
 * `permissions.js` 单测：cua-driver `check_permissions` → UI 权限契约映射。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createCuaDriverPermissionService,
  isCuaPermissionStatusAvailable,
  projectCuaPermissionStatus,
  shouldRunCuaScreenCaptureProbe,
} from "../permissions.js";

test("macOS 布尔权限映射为 granted/denied", () => {
  const status = projectCuaPermissionStatus(
    { accessibility: true, screen_recording: false },
    { platform: "darwin" },
  );
  assert.equal(status.available, true);
  assert.equal(status.accessibility, "granted");
  assert.equal(status.screenRecording, "denied");
});

test("非 macOS 返回 unavailable", () => {
  const status = projectCuaPermissionStatus({ atspi: true }, { platform: "linux" });
  assert.equal(status.available, false);
  assert.match(status.reason, /macOS/);
});

test("macOS 未上报权限键返回 unavailable", () => {
  const status = projectCuaPermissionStatus({ wayland: true }, { platform: "darwin" });
  assert.equal(status.available, false);
});

test("权限服务把 check_permissions 结果投影为契约", async () => {
  const calls = [];
  const client = {
    async callTool(toolName, argsJson) {
      calls.push({ toolName, argsJson });
      return { structuredJson: JSON.stringify({ accessibility: true, screen_recording: true }) };
    },
  };
  const service = createCuaDriverPermissionService({ client, platform: "darwin" });
  const status = await service.getStatus("/w", "w");
  assert.equal(isCuaPermissionStatusAvailable(status), true);
  assert.equal(status.accessibility, "granted");
  assert.equal(calls[0].toolName, "check_permissions");
});

test("缺 client 时 fail-closed", async () => {
  const service = createCuaDriverPermissionService({ platform: "darwin" });
  const status = await service.getStatus("/w", "w");
  assert.equal(status.available, false);
  assert.match(status.reason, /client/);
});

test("check_permissions 抛错时 fail-closed 并带原因", async () => {
  const client = {
    async callTool() {
      throw new Error("driver is down");
    },
  };
  const service = createCuaDriverPermissionService({ client, platform: "darwin" });
  const status = await service.getStatus("/w", "w");
  assert.equal(status.available, false);
  assert.equal(status.reason, "driver is down");
});

test("restartHelper 在新路径下是 no-op 成功", async () => {
  const service = createCuaDriverPermissionService({ platform: "darwin" });
  assert.deepEqual(await service.restartHelper(), { ok: true });
});

test("抓屏探测默认关闭，仅在显式允许且未授予时为真", () => {
  assert.equal(shouldRunCuaScreenCaptureProbe("denied"), false);
  assert.equal(shouldRunCuaScreenCaptureProbe("denied", { probeScreenCapture: true }), true);
  assert.equal(shouldRunCuaScreenCaptureProbe("granted", { probeScreenCapture: true }), false);
});
