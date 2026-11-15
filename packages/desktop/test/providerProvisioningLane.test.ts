import { describe, expect, it, vi } from "vitest";
import type { ProviderProvisioningTrigger } from "@zcode/shared";
import {
  ProviderProvisioningEnvironmentCoordinator,
  ProviderProvisioningExecutionError,
} from "../src/main/providerProvisioningEnvironmentCoordinator.js";

/**
 * 数据同步页「模型提供商」分类的 lane 读取 / 重试。
 * 唯一数据源是 Main 协调器的内存 lane：查询只投影最近结果，重试复用同一条 single-flight lane
 * 的尾随代际；没有注册（设备没打开项目）时不执行任何同步。
 *
 * 全部在内存中完成，不创建 Host 进程、不连远端、不读写真实配置。
 */

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("provider provisioning lane", () => {
  it("无 lane 时查询与重试都返回 none，且不执行同步", async () => {
    const coordinator = new ProviderProvisioningEnvironmentCoordinator();
    expect(await coordinator.getLaneStatus("source-a")).toEqual({ lane: "none" });
    expect(await coordinator.retry("source-a")).toEqual({ lane: "none" });
  });

  it("按 Source 设备投影 running 与最近结果，不跨设备串台", async () => {
    const coordinator = new ProviderProvisioningEnvironmentCoordinator({ now: () => 42 });
    const running = deferred();
    const execute = vi.fn(() => running.promise);
    const registration = coordinator.register("environment-a", "session-a", execute, "source-a");
    // 首次上线屏障仍在执行：状态 running，且此时还没有结果。
    expect(await coordinator.getLaneStatus("source-a")).toEqual({
      lane: "present",
      running: true,
    });
    expect(await coordinator.getLaneStatus("source-b")).toEqual({ lane: "none" });
    running.resolve();
    await registration.initialSync;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await coordinator.getLaneStatus("source-a")).toEqual({
      lane: "present",
      running: false,
      lastResult: { at: 42, outcome: "success" },
    });
    registration.dispose();
  });

  it("失败记录固定阶段码；重试复用同一条 lane 并推进到成功", async () => {
    const coordinator = new ProviderProvisioningEnvironmentCoordinator({ now: () => 7 });
    const triggers: ProviderProvisioningTrigger[] = [];
    let attempt = 0;
    const execute = vi.fn(async (trigger: ProviderProvisioningTrigger) => {
      triggers.push(trigger);
      attempt += 1;
      if (attempt === 1) {
        throw new ProviderProvisioningExecutionError("boom", "target-call-failed");
      }
    });
    const registration = coordinator.register("environment-a", "session-a", execute, "source-a");
    await expect(registration.initialSync).rejects.toThrow("boom");
    expect(await coordinator.getLaneStatus("source-a")).toEqual({
      lane: "present",
      running: false,
      lastResult: { at: 7, outcome: "failed", errorCode: "target-call-failed" },
    });

    expect(await coordinator.retry("source-a")).toEqual({
      lane: "present",
      running: false,
      lastResult: { at: 7, outcome: "success" },
    });
    expect(triggers).toEqual(["environment-online", "user-retry"]);
    registration.dispose();
  });

  it("执行中重试合并进尾随代际，首次失败后仍会执行本次代际", async () => {
    const coordinator = new ProviderProvisioningEnvironmentCoordinator({ now: () => 9 });
    const triggers: ProviderProvisioningTrigger[] = [];
    const first = deferred();
    const execute = vi.fn(async (trigger: ProviderProvisioningTrigger) => {
      triggers.push(trigger);
      if (triggers.length === 1) {
        await first.promise;
        throw new Error("first-online failed");
      }
    });
    const registration = coordinator.register("environment-a", "session-a", execute, "source-a");
    const retry = coordinator.retry("source-a");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    first.resolve();
    // 首次失败属于上线屏障，registration.initialSync 会抛出；重试自己再起一轮执行本次代际。
    await expect(registration.initialSync).rejects.toThrow("first-online failed");
    expect(await retry).toEqual({
      lane: "present",
      running: false,
      lastResult: { at: 9, outcome: "success" },
    });
    expect(triggers).toEqual(["environment-online", "user-retry"]);
    registration.dispose();
  });

  it("waitForIdle 等当前 drain 结束后返回本次执行结果", async () => {
    const coordinator = new ProviderProvisioningEnvironmentCoordinator({ now: () => 3 });
    const gate = deferred();
    const registration = coordinator.register(
      "environment-a",
      "session-a",
      async () => await gate.promise,
      "source-a",
    );
    const status = coordinator.getLaneStatus("source-a", { waitForIdle: true });
    gate.resolve();
    await registration.initialSync;
    expect(await status).toEqual({
      lane: "present",
      running: false,
      lastResult: { at: 3, outcome: "success" },
    });
    registration.dispose();
  });
});
