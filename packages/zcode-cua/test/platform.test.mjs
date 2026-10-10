/**
 * `platform.js` 单测：平台装配（Linux compat / macOS native / 缺 client fail-closed）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleComputerUseRuntime,
  createCompatRuntimeOptions,
  describeCompatReadiness,
} from "../platform.js";
import { assembleCuaPermissionServiceAsync } from "../platform.js";

function makeClient() {
  return {
    async callTool() {
      return {
        text: "",
        structuredJson: "{}",
        images: [],
        isError: false,
        degraded: false,
        rawJson: "{}",
      };
    },
  };
}

function makeCompat() {
  const calls = [];
  return {
    calls,
    applies: true,
    async execute(input) {
      calls.push(input);
      return { content: [{ type: "text", text: "compat ok" }], isError: false };
    },
  };
}

const GNOME42 = { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" };
const PROBES = { gnomeShellVersion: "42", portalRemoteDesktopVersion: "1", winRectsVersion: "8" };

test("macOS：native，报告需要 TCC", async () => {
  const client = makeClient();
  const { path, runtime, requiresMacOsPermissions } = assembleComputerUseRuntime({
    platform: "darwin",
    client,
  });
  assert.equal(path.path, "native");
  assert.equal(requiresMacOsPermissions, true);
  const result = await runtime.execute({ toolName: "list_apps", arguments: {}, context: {} });
  assert.equal(result.isError, false);
});

test("Linux 老 GNOME + client：compat，输入类走 compat", async () => {
  const client = makeClient();
  const compat = makeCompat();
  const { path, runtime, requiresMacOsPermissions } = assembleComputerUseRuntime({
    platform: "linux",
    env: GNOME42,
    probes: PROBES,
    client,
    compat,
  });
  assert.equal(path.path, "compat");
  assert.equal(requiresMacOsPermissions, false);
  await runtime.execute({ toolName: "type_text", arguments: { text: "hi" }, context: {} });
  assert.equal(compat.calls.length, 1);
  assert.equal(compat.calls[0].toolName, "type_text");
});

test("Linux 老 GNOME 未注入 compat 时默认组装（不抛错）", () => {
  const { path, runtime } = assembleComputerUseRuntime({
    platform: "linux",
    env: GNOME42,
    probes: PROBES,
    client: makeClient(),
  });
  assert.equal(path.path, "compat");
  assert.equal(typeof runtime.execute, "function");
});

test("Windows：native（嵌入由另一路负责）", () => {
  const { path, requiresMacOsPermissions } = assembleComputerUseRuntime({
    platform: "win32",
    client: makeClient(),
  });
  assert.equal(path.path, "native");
  assert.equal(requiresMacOsPermissions, false);
});

test("缺 client：fail-closed，且给出原因", async () => {
  const { runtime } = assembleComputerUseRuntime({ platform: "darwin" });
  const result = await runtime.execute({ toolName: "list_apps", arguments: {}, context: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /cua-driver client/i);
});

test("unavailable 平台（KWin）：fail-closed", async () => {
  const { path, runtime } = assembleComputerUseRuntime({
    platform: "linux",
    env: { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "KDE" },
    client: makeClient(),
  });
  assert.equal(path.path, "unavailable");
  const result = await runtime.execute({ toolName: "list_apps", arguments: {}, context: {} });
  assert.equal(result.isError, true);
});

test("connectDriver 收到 socketPath", () => {
  let seen;
  const { runtime } = assembleComputerUseRuntime({
    platform: "darwin",
    socketPath: "/tmp/cua.sock",
    connectDriver: (socketPath) => {
      seen = socketPath;
      return makeClient();
    },
  });
  assert.equal(seen, "/tmp/cua.sock");
  assert.equal(typeof runtime.execute, "function");
});

test("createCompatRuntimeOptions 返回 applies 端口", () => {
  const helper = {
    async request() {
      return { ok: true };
    },
  };
  const options = createCompatRuntimeOptions({ client: makeClient(), helper });
  assert.equal(options.applies, true);
  assert.equal(typeof options.execute, "function");
});

test("describeCompatReadiness：老 GNOME 未加载扩展 → 需要安装 + 重登", () => {
  const result = describeCompatReadiness({
    gnomeShellVersion: "42",
    portalRemoteDesktopVersion: "1",
  });
  assert.equal(result.ready, false);
  assert.equal(result.needsExtension, true);
  assert.match(result.guidance, /install:gnome-extension/);
});

test("describeCompatReadiness：扩展可达 / 新 GNOME → 就绪", () => {
  assert.equal(
    describeCompatReadiness({
      gnomeShellVersion: "42",
      portalRemoteDesktopVersion: "1",
      winRectsVersion: "8",
    }).ready,
    true,
  );
  assert.equal(
    describeCompatReadiness({ gnomeShellVersion: "46", portalRemoteDesktopVersion: "2" }).ready,
    true,
  );
});

test("Linux Wayland 会话自动启用 cua-driver Wayland 窗口后端", () => {
  const env = { XDG_SESSION_TYPE: "wayland" };
  assembleComputerUseRuntime({ platform: "linux", env, client: makeClient() });
  assert.equal(env.CUA_DRIVER_RS_ENABLE_WAYLAND, "1");
});

test("Linux X11 会话不启用 Wayland 后端", () => {
  const env = { XDG_SESSION_TYPE: "x11" };
  assembleComputerUseRuntime({ platform: "linux", env, client: makeClient() });
  assert.equal(env.CUA_DRIVER_RS_ENABLE_WAYLAND, undefined);
});

test("已显式设置的驱动后端变量不被覆盖", () => {
  const env = { XDG_SESSION_TYPE: "wayland", CUA_DRIVER_RS_ENABLE_WAYLAND: "0" };
  assembleComputerUseRuntime({ platform: "linux", env, client: makeClient() });
  assert.equal(env.CUA_DRIVER_RS_ENABLE_WAYLAND, "0");
});

test("assembleCuaPermissionServiceAsync 用注入 driver 提供 check_permissions", async () => {
  const calls = [];
  const fakeDriver = {
    create: () => ({
      callTool: async (name) => {
        calls.push(name);
        return { structuredJson: JSON.stringify({ accessibility: true, screen_recording: false }) };
      },
    }),
  };
  const service = await assembleCuaPermissionServiceAsync({
    platform: "darwin",
    env: {},
    driverModule: fakeDriver,
  });
  const status = await service.getStatus("/w", "w");
  assert.equal(status.available, true);
  assert.equal(status.accessibility, "granted");
  assert.equal(status.screenRecording, "denied");
  assert.equal(calls[0], "check_permissions");
});

test("assembleCuaPermissionServiceAsync 有 socket 时优先 connect", async () => {
  let connected;
  const fakeDriver = {
    connect: (socketPath) => {
      connected = socketPath;
      return { callTool: async () => ({ structuredJson: "{}" }) };
    },
  };
  await assembleCuaPermissionServiceAsync({
    platform: "darwin",
    socketPath: "/tmp/cua.sock",
    driverModule: fakeDriver,
    env: {},
  });
  assert.equal(connected, "/tmp/cua.sock");
});

test("assembleCuaPermissionServiceAsync 在 Wayland 会话设置窗口后端开关", async () => {
  const env = { XDG_SESSION_TYPE: "wayland" };
  const fakeDriver = { create: () => ({ callTool: async () => ({ structuredJson: "{}" }) }) };
  await assembleCuaPermissionServiceAsync({ platform: "linux", env, driverModule: fakeDriver });
  assert.equal(env.CUA_DRIVER_RS_ENABLE_WAYLAND, "1");
});
