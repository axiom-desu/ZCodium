/**
 * `macos-permissions.js` 单测：TCC 申请 / 判定 / 打开设置面板（注入假宿主，不碰真原生库）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  hasRequiredMacOSPermissions,
  loadMacOSPermissionHost,
  openMacOSScreenRecordingSettingsPanel,
  requestMacOSPermissionsFromHost,
} from "../macos-permissions.js";

test("归一化宿主返回的权限状态", async () => {
  const status = await requestMacOSPermissionsFromHost({
    load: async () => ({
      requestMacOSPermissions: () => ({ accessibility: true, screenRecording: false }),
    }),
  });
  assert.deepEqual(status, { accessibility: true, screenRecording: false });
  assert.equal(hasRequiredMacOSPermissions(status), false);
});

test("两项都授予才算 ready", () => {
  assert.equal(hasRequiredMacOSPermissions({ accessibility: true, screenRecording: true }), true);
  assert.equal(hasRequiredMacOSPermissions({ accessibility: true, screenRecording: false }), false);
  assert.equal(hasRequiredMacOSPermissions(undefined), false);
});

test("宿主缺 requestMacOSPermissions 时 fail-closed 返回 undefined", async () => {
  assert.equal(await requestMacOSPermissionsFromHost({ load: async () => ({}) }), undefined);
  assert.equal(await requestMacOSPermissionsFromHost({ load: async () => null }), undefined);
});

test("加载失败（非 macOS / 原生库缺失）不抛，返回 undefined", async () => {
  assert.equal(
    await requestMacOSPermissionsFromHost({
      load: async () => {
        throw new Error("nope");
      },
    }),
    undefined,
  );
  assert.equal(
    await openMacOSScreenRecordingSettingsPanel({
      load: async () => {
        throw new Error("nope");
      },
    }),
    false,
  );
});

test("打开设置面板成功返回 true", async () => {
  const calls = [];
  const ok = await openMacOSScreenRecordingSettingsPanel({
    load: async () => ({
      openMacOSScreenRecordingSettings: async () => {
        calls.push("open");
      },
    }),
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, ["open"]);
});

test("打开设置面板抛错时吞掉并返回 false", async () => {
  const ok = await openMacOSScreenRecordingSettingsPanel({
    load: async () => ({
      openMacOSScreenRecordingSettings: async () => {
        throw new Error("denied");
      },
    }),
  });
  assert.equal(ok, false);
});

test("loadMacOSPermissionHost 把入口原样交回", async () => {
  const entry = { requestMacOSPermissions: () => ({ accessibility: true, screenRecording: true }) };
  assert.equal(await loadMacOSPermissionHost({ load: async () => entry }), entry);
});
