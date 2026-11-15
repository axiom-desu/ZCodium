import { describe, expect, it } from "vitest";
import {
  REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE,
  REMOTE_WORKSPACE_DIRECTORY_UNRESPONSIVE_ERROR_CODE,
} from "@zcode/shared";
import type { IFileService } from "@zcode/services";
import { prepareRemoteWorkspaceIdentity } from "./remoteWorkspacePreparation.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

describe("prepareRemoteWorkspaceIdentity", () => {
  it("截止后 abort 本次 admission，迟到的目录读取不能继续登记身份", async () => {
    const read = deferred<unknown>();
    let readdirCalls = 0;
    const fileService = {
      readdir: () => {
        readdirCalls += 1;
        return read.promise;
      },
    } as unknown as Pick<IFileService, "readdir">;
    let bindCalls = 0;
    await expect(
      prepareRemoteWorkspaceIdentity(
        fileService,
        { workspacePath: "/remote/project", stableWorkspaceIdentity: "remote:project" },
        async () => {
          bindCalls += 1;
        },
        { timeoutMs: 25 },
      ),
    ).rejects.toMatchObject({
      code: REMOTE_WORKSPACE_DIRECTORY_UNRESPONSIVE_ERROR_CODE,
      retryable: true,
    });
    // 远端调用在截止后返回：promise 已完成，不能再调用 bind 登记身份。
    read.resolve([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(readdirCalls).toBe(1);
    expect(bindCalls).toBe(0);
  });

  it("同一 fileService 同一路径的单飞读取只发一次远端调用", async () => {
    const read = deferred<unknown>();
    let readdirCalls = 0;
    const fileService = {
      readdir: () => {
        readdirCalls += 1;
        return read.promise;
      },
    } as unknown as Pick<IFileService, "readdir">;
    const first = prepareRemoteWorkspaceIdentity(fileService, {
      workspacePath: "/remote/project",
      stableWorkspaceIdentity: "remote:project",
    });
    const second = prepareRemoteWorkspaceIdentity(fileService, {
      workspacePath: "/remote/project",
      stableWorkspaceIdentity: "remote:project",
    });
    await Promise.resolve();
    expect(readdirCalls).toBe(1);
    read.resolve([]);
    await expect(Promise.all([first, second])).resolves.toBeDefined();
    // 返回即删，不缓存结果。
    const third = prepareRemoteWorkspaceIdentity(fileService, {
      workspacePath: "/remote/project",
      stableWorkspaceIdentity: "remote:project",
    });
    await Promise.resolve();
    expect(readdirCalls).toBe(2);
    read.resolve([]);
    await expect(third).resolves.toBeUndefined();
  });

  it("目录不可读映射为不可重试的 unavailable，而不是截止错误", async () => {
    const fileService = {
      readdir: async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    } as unknown as Pick<IFileService, "readdir">;
    await expect(
      prepareRemoteWorkspaceIdentity(fileService, {
        workspacePath: "/remote/project",
        stableWorkspaceIdentity: "remote:project",
      }),
    ).rejects.toMatchObject({
      code: REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE,
      retryable: false,
    });
  });
});
