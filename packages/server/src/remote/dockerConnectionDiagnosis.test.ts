import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { normalizeRemoteConnectionError } from "@zcode/shared";
import { createSourceServerTransportAdapter } from "@zcode/server/source-server/transportAdapter.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DockerBackend } from "./docker-backend.js";

const fixture = vi.hoisted(() => ({ daemonError: "", probes: 0, commands: 0 }));

// 只替换 CLI IO；真实 docker-detect → DockerBackend → adapter → shared 分类链全部执行。
vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      _command: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const isProbe = args[0] === "version";
      if (isProbe) fixture.probes++;
      const detail = isProbe ? fixture.daemonError : "";
      const stdout =
        args[0] === "ps"
          ? JSON.stringify({ ID: "fixture-id", Names: "fixture", State: "running" })
          : isProbe
            ? "1.0"
            : "/home/fixture";
      queueMicrotask(() => callback(detail ? new Error(detail) : null, stdout, detail));
    },
  ),
  spawn: vi.fn(() => {
    fixture.commands++;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    queueMicrotask(() => {
      child.emit("spawn");
      child.stdout.end();
      child.stderr.end("fixture container command failed");
      child.emit("exit", 42, null);
      child.emit("close", 42, null);
    });
    return child;
  }),
}));

beforeEach(() => {
  fixture.daemonError = "";
  fixture.probes = 0;
  fixture.commands = 0;
});

describe("Docker daemon 领域诊断跨层保留", () => {
  it.each([
    ["首次探测", false, "dial unix /home/private-fixture/docker.sock: connect: permission denied"],
    ["首次探测", false, "connection refused"],
    ["缓存后诊断", true, "dial unix /home/private-fixture/docker.sock: connect: permission denied"],
    ["缓存后诊断", true, "connection refused"],
    ["非英文原因", false, "合成 daemon 环境不可用"],
  ] as const)("%s（已有缓存=%s）：%s", async (_name, cached, detail) => {
    const target = { kind: "docker", container: "fixture" } as const;
    const backend = new DockerBackend(target);
    const adapter = createSourceServerTransportAdapter("docker", {
      createBackend: async () => backend,
      rootReadPath: "~/fixture-server",
    });
    try {
      if (cached) await backend.diagnoseExecFailure();
      fixture.daemonError = detail;
      // probe 的 catch 会实际调用 shared normalize，不仅断言 backend 自己抛出的 code。
      const error: unknown = await adapter.probe(target, {}).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ code: "remote-connection-unknown" });
      const cause = (error as Error).cause;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).message).toBe(detail);
      expect((error as Error).message).not.toContain("private-fixture");
      expect((error as Error).message).toContain(
        detail.includes("dial unix") ? "[redacted-path]: connect: permission denied" : detail,
      );
      // 后续 Host 按阶段再次归一化，也不能越过领域边界挖 cause 或改成 preflight。
      expect(normalizeRemoteConnectionError(error, "preflight")).toMatchObject({
        code: "remote-connection-unknown",
      });
      expect((error as Error).cause).toBe(cause);
      expect(fixture.probes).toBe(cached ? 2 : 1);
      expect(fixture.commands).toBe(cached ? 1 : 0);
    } finally {
      adapter.dispose?.();
    }
  });
});
