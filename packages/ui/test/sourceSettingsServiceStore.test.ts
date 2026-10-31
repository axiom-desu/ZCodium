import { describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import {
  ensureSourceSettingsServices,
  getSourceSettingsServices,
  invalidateAllSourceSettingsServices,
  reconcileSourceSettingsConnections,
  registerSourceSettingsServices,
} from "@/store/sourceSettingsServiceStore.js";

function services(token: string): IServiceAccessor {
  return { token } as unknown as IServiceAccessor;
}

describe("source-settings attachment 注册", () => {
  it("同一 Source 换代后旧 attachment 的注销不会删掉新服务", () => {
    const sourceServerId = "11111111-1111-4111-8111-111111111111";
    const firstServices = services("first");
    const secondServices = services("second");
    const disposeFirst = vi.fn();
    const disposeSecond = vi.fn();
    const unregisterFirst = registerSourceSettingsServices({
      sourceServerId,
      attachmentId: "a-1",
      services: firstServices,
      dispose: disposeFirst,
    });
    const unregisterSecond = registerSourceSettingsServices({
      sourceServerId,
      attachmentId: "a-2",
      services: secondServices,
      dispose: disposeSecond,
    });

    // 新一代注册会释放上一代，但旧 close 迟到时不能再删除当前服务。
    expect(disposeFirst).toHaveBeenCalledTimes(1);
    expect(getSourceSettingsServices(sourceServerId)).toBe(secondServices);

    unregisterFirst();
    expect(getSourceSettingsServices(sourceServerId)).toBe(secondServices);

    unregisterSecond();
    expect(getSourceSettingsServices(sourceServerId)).toBeUndefined();
    expect(disposeSecond).toHaveBeenCalledTimes(1);
  });

  it("同一 Source 的并发请求只 admitted 一次", async () => {
    const sourceServerId = "22222222-2222-4222-8222-222222222222";
    let resolveAttachment: (() => void) | null = null;
    const request = vi.fn(
      (id: string) =>
        new Promise<{ attachmentId: string }>((resolve) => {
          resolveAttachment = () => {
            registerSourceSettingsServices({
              sourceServerId: id,
              attachmentId: "a-1",
              services: services("once"),
              dispose: vi.fn(),
            });
            resolve({ attachmentId: "a-1" });
          };
        }),
    );

    const first = ensureSourceSettingsServices(sourceServerId, "online@1", request);
    const second = ensureSourceSettingsServices(sourceServerId, "online@1", request);
    expect(request).toHaveBeenCalledTimes(1);
    resolveAttachment?.();
    await Promise.all([first, second]);

    // 已注册后不再发请求。
    await ensureSourceSettingsServices(sourceServerId, "online@1", request);
    expect(request).toHaveBeenCalledTimes(1);
    invalidateAllSourceSettingsServices();
  });

  it("断线/重连换代清除旧 proxy，下一代替换后必须重新 admission", async () => {
    const sourceServerId = "33333333-3333-4333-8333-333333333333";
    const dispose = vi.fn();
    reconcileSourceSettingsConnections(new Map([[sourceServerId, "online@1"]]));
    registerSourceSettingsServices({
      sourceServerId,
      attachmentId: "a-1",
      services: services("first"),
      dispose,
    });
    expect(getSourceSettingsServices(sourceServerId)).toBeTruthy();

    // 同一 Source 断线：旧 attachment 立即失效，不能继续可写。
    reconcileSourceSettingsConnections(new Map([[sourceServerId, "offline@2"]]));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(getSourceSettingsServices(sourceServerId)).toBeUndefined();

    // 重连换代后重新 admission，旧代请求不会顶替新代。
    const request = vi.fn(async (id: string) => {
      registerSourceSettingsServices({
        sourceServerId: id,
        attachmentId: "a-2",
        services: services("second"),
        dispose: vi.fn(),
      });
      return { attachmentId: "a-2" };
    });
    reconcileSourceSettingsConnections(new Map([[sourceServerId, "online@3"]]));
    await ensureSourceSettingsServices(sourceServerId, "online@3", request);
    expect(request).toHaveBeenCalledTimes(1);
    expect(getSourceSettingsServices(sourceServerId)).toBeTruthy();

    // Source 从快照消失（删除/移除）同样清空。
    reconcileSourceSettingsConnections(new Map());
    expect(getSourceSettingsServices(sourceServerId)).toBeUndefined();
  });

  it("跨代迟到的 admission 不能冒充当前代，也不能覆盖别的 Source", async () => {
    const sourceA = "44444444-4444-4444-8444-444444444444";
    const sourceB = "55555555-5555-4555-8555-555555555555";
    reconcileSourceSettingsConnections(
      new Map([
        [sourceA, "online@1"],
        [sourceB, "online@1"],
      ]),
    );
    const disposeLateA = vi.fn();
    let releaseLateA: (() => void) | null = null;
    const lateA = ensureSourceSettingsServices(
      sourceA,
      "online@1",
      () =>
        new Promise((resolve) => {
          releaseLateA = () => {
            registerSourceSettingsServices({
              sourceServerId: sourceA,
              attachmentId: "late-a",
              services: services("late-a"),
              dispose: disposeLateA,
            });
            resolve({ attachmentId: "late-a" });
          };
        }),
    );
    const requestB = vi.fn(async (id: string) => {
      registerSourceSettingsServices({
        sourceServerId: id,
        attachmentId: "b-1",
        services: services("b"),
        dispose: vi.fn(),
      });
      return { attachmentId: "b-1" };
    });
    await ensureSourceSettingsServices(sourceB, "online@1", requestB);
    const bServices = getSourceSettingsServices(sourceB);
    expect(bServices).toBeTruthy();

    // A 在请求期间断线重连换代：旧代 attachment 晚到时只能被丢弃。
    reconcileSourceSettingsConnections(
      new Map([
        [sourceA, "online@2"],
        [sourceB, "online@1"],
      ]),
    );
    releaseLateA?.();
    await lateA;
    expect(disposeLateA).toHaveBeenCalledTimes(1);
    expect(getSourceSettingsServices(sourceA)).toBeUndefined();
    expect(getSourceSettingsServices(sourceB)).toBe(bServices);
    invalidateAllSourceSettingsServices();
  });
});
