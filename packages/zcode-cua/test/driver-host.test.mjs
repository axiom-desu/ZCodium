/**
 * `driver-host.js` 单测：cua-driver 二进制解析与嵌入宿主装配（注入假 driver）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createEmbeddedCuaDriverHost, resolveCuaDriverBinaryPath } from "../driver-host.js";

test("打包 macOS 优先用 Resources/cua-driver", () => {
  const found = resolveCuaDriverBinaryPath({
    platform: "darwin",
    isPackaged: true,
    resourcesPath: "/App/Contents/Resources",
    env: {},
    existsSync: (p) => p === "/App/Contents/Resources/cua-driver/cua-driver",
  });
  assert.equal(found, "/App/Contents/Resources/cua-driver/cua-driver");
});

test("显式 ZCODE_CUA_DRIVER_BIN 次之", () => {
  const found = resolveCuaDriverBinaryPath({
    platform: "linux",
    env: { ZCODE_CUA_DRIVER_BIN: "/opt/cua/cua-driver", PATH: "/usr/bin" },
    existsSync: (p) => p === "/opt/cua/cua-driver",
  });
  assert.equal(found, "/opt/cua/cua-driver");
});

test("回退到 PATH 查找，找不到返回 undefined", () => {
  const found = resolveCuaDriverBinaryPath({
    platform: "linux",
    env: { PATH: "/a:/b" },
    existsSync: (p) => p === "/b/cua-driver",
  });
  assert.equal(found, "/b/cua-driver");
  assert.equal(
    resolveCuaDriverBinaryPath({ platform: "linux", env: { PATH: "/a" }, existsSync: () => false }),
    undefined,
  );
});

test("Windows 查找 .exe", () => {
  const found = resolveCuaDriverBinaryPath({
    platform: "win32",
    env: { PATH: "C:\\tools" },
    existsSync: (p) => p === "C:\\tools\\cua-driver.exe",
  });
  assert.equal(found, "C:\\tools\\cua-driver.exe");
});

test("无 SDK 时返回 undefined（fail-closed）", async () => {
  assert.equal(
    await createEmbeddedCuaDriverHost({ binaryPath: "/x/cua-driver", driverModule: {} }),
    undefined,
  );
});

test("装配的宿主把生命周期方法透传", async () => {
  const calls = [];
  class FakeHost {
    constructor(binaryPath, hostBundleId) {
      calls.push(["ctor", binaryPath, hostBundleId]);
    }
    start() {
      calls.push(["start"]);
      return Promise.resolve({ socketPath: "/tmp/s.sock", generation: "g1" });
    }
    stop() {
      calls.push(["stop"]);
      return Promise.resolve();
    }
    connection() {
      return { socketPath: "/tmp/s.sock" };
    }
    state() {
      return 2;
    }
    uniffiDestroy() {
      calls.push(["destroy"]);
    }
  }
  const host = await createEmbeddedCuaDriverHost({
    binaryPath: "/x/cua-driver",
    hostBundleId: "dev.zcode.test",
    driverModule: { EmbeddedCuaDriverHost: FakeHost },
  });
  assert.equal(host.binaryPath, "/x/cua-driver");
  const connection = await host.start();
  assert.equal(connection.socketPath, "/tmp/s.sock");
  assert.equal(host.state(), 2);
  await host.stop();
  host.dispose();
  assert.deepEqual(calls, [
    ["ctor", "/x/cua-driver", "dev.zcode.test"],
    ["start"],
    ["stop"],
    ["destroy"],
  ]);
});

test("没有二进制时不装配", async () => {
  const host = await createEmbeddedCuaDriverHost({
    binaryPath: undefined,
    env: {},
    existsSync: () => false,
    driverModule: { EmbeddedCuaDriverHost: class {} },
  });
  assert.equal(host, undefined);
});
