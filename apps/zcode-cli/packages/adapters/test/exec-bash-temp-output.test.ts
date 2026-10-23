import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ExecutionRequest, TraceContext } from "@zcode/contracts";
import { NodeExecutionAdapter, createNodeExecutionAdapter } from "../src/exec/index.js";
import type { PreparedChildSpawn } from "../src/exec/execution-adapter-types.js";

const INLINE_BYTES = 10 * 1024 * 1024;
let sandbox: string;
let workdir: string;
let artifacts: string;
let callSequence = 0;

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "zcode-bash-temp-test-"));
  workdir = join(sandbox, "workspace");
  artifacts = join(sandbox, "artifacts");
  await mkdir(workdir, { recursive: true });
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function tempParent(name: string): string {
  return join(sandbox, `tmp-${name}`);
}

function bashRequest(command: string, overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  callSequence += 1;
  return {
    command: { mode: "shell", command, shellProfile: "posix-bash" },
    cwd: workdir,
    timeoutMs: 30_000,
    outputLimit: {
      maxInlineBytes: INLINE_BYTES,
      maxBufferBytes: INLINE_BYTES,
      maxPersistedBytes: 5 * 1024 * 1024 * 1024,
      // 前台本身按 on_truncate 保留；这里固定 always 以便断言「冻结路径」确实出现在结果里。
      persistOutput: "always",
    },
    trace: {
      traceId: "trace",
      spanId: "span",
      sessionId: "session-temp-output",
      attributes: { toolCallId: `call-${callSequence}`, toolName: "Bash" },
    } as unknown as TraceContext,
    ...overrides,
  };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met before the deadline");
}

/** temp 根下本会话的所有 Bash 输出文件；空文件即「未使用却新建」的泄漏文件。 */
async function outputFiles(root: string, session = "session-temp-output"): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    if (!entry.startsWith("zcode-bash-")) continue;
    const names = await readdir(join(root, entry, session)).catch(() => []);
    files.push(...names.filter((name) => name.endsWith(".log")).map((name) => join(entry, name)));
  }
  return files;
}

describe("Bash output tmp isolation", () => {
  it("freezes one zcode-bash temp root per adapter and reads the output back", async () => {
    const parent = tempParent("ok");
    await mkdir(parent, { recursive: true });
    const adapter = createNodeExecutionAdapter({
      outputRootDir: artifacts,
      bashOutputTempDir: parent,
    });
    try {
      const first = await adapter.run(bashRequest("printf temp-one"));
      assert.equal(first.status, "completed");
      const firstPath = first.stdout.artifactPath;
      assert.ok(firstPath, "Bash must report the frozen output path");
      const firstRelative = relative(parent, firstPath);
      assert.ok(
        firstRelative.startsWith(`zcode-bash-`) && !firstRelative.startsWith(".."),
        `Bash output must live under the injected tmp parent, got ${firstPath}`,
      );
      // Read 入口使用同一个已定路径：文件必须真实可读且内容完整。
      assert.equal(await readFile(firstPath, "utf8"), "temp-one");

      const second = await adapter.run(bashRequest("printf temp-two"));
      assert.equal(second.status, "completed");
      const secondPath = second.stdout.artifactPath;
      assert.ok(secondPath);
      assert.equal(await readFile(secondPath, "utf8"), "temp-two");
      assert.equal(
        firstRelative.split(sep)[0],
        relative(parent, secondPath).split(sep)[0],
        "每个进程生命周期只创建一个 zcode-bash 根目录",
      );
      assert.deepEqual(await readdir(parent), [firstRelative.split(sep)[0]]);
      assert.deepEqual(
        await readdir(artifacts).catch(() => []),
        ["shell-snapshots"],
        "除了 shell init snapshot，Bash 输出不应落回 artifacts 数据根",
      );
    } finally {
      await adapter.close?.();
    }
  });

  it("falls back to the existing artifacts root when the tmp parent is not a directory", async () => {
    // 可移植的 ENOTDIR fixture：父路径是普通文件而不是目录。
    // 不用 chmod 制造不可写，因为 root/管理员身份会绕过权限位。
    const parent = tempParent("blocked");
    await writeFile(parent, "not a directory");
    const adapter = createNodeExecutionAdapter({
      outputRootDir: artifacts,
      bashOutputTempDir: parent,
    });
    try {
      const result = await adapter.run(bashRequest("printf fallback-output"));
      assert.equal(result.status, "completed");
      const path = result.stdout.artifactPath;
      assert.ok(path);
      const relativePath = relative(artifacts, path);
      assert.ok(
        !relativePath.startsWith("..") && relativePath.length > 0,
        `降级输出必须回到原有 artifacts 路径，实际 ${path}`,
      );
      assert.equal(await readFile(path, "utf8"), "fallback-output");
    } finally {
      await adapter.close?.();
    }
  });

  it(
    "reports spawn_error without spawning when preparation fails outside the fallback set",
    { skip: process.platform === "win32" },
    async () => {
      // ELOOP 不在降级集合里：准备失败必须显式报 spawn_error，不能凭空写入 artifacts。
      const loop = tempParent("loop");
      await symlink(basename(loop), loop);
      const adapter = createNodeExecutionAdapter({
        outputRootDir: artifacts,
        bashOutputTempDir: loop,
      });
      try {
        const marker = join(workdir, "spawn-marker");
        const result = await adapter.run(bashRequest(`printf spawned > ${marker}`));
        assert.equal(result.status, "spawn_error");
        assert.match(result.error?.message ?? "", /loop|ELOOP/i);
        await assert.rejects(readFile(marker), "准备失败的 Bash 不能启动子进程");
        // 未公布冻结路径，也没有把这次准备算成一次可用输出。
        assert.equal(result.stdout.artifactPath, undefined);
        // 失败不缓存：同一个 adapter 在 tmp 恢复后用同一请求可以重新拿到 tmp 路径。
        await rm(loop, { force: true });
        await mkdir(loop);
        const recovered = await adapter.run(bashRequest("printf recovered"));
        assert.equal(recovered.status, "completed");
        assert.ok(relative(loop, recovered.stdout.artifactPath ?? "").startsWith("zcode-bash-"));
      } finally {
        await adapter.close?.();
      }
    },
  );

  it("does not spawn or keep an unused output file when cancelled after preparation", async () => {
    const parent = tempParent("cancel");
    await mkdir(parent, { recursive: true });
    let releaseSpawn: () => void = () => undefined;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    // 在命令行准备入口拦住 run()：用文件存在证明「已创建冻结输出文件」，再取消，
    // 消除取消落在准备之前/之后的竞态，稳定覆盖准备期取消分支。
    class GatedAdapter extends NodeExecutionAdapter {
      protected override async prepareChildSpawn(
        request: ExecutionRequest,
      ): Promise<PreparedChildSpawn> {
        await spawnGate;
        return await super.prepareChildSpawn(request);
      }
    }
    const adapter = new GatedAdapter({ outputRootDir: artifacts, bashOutputTempDir: parent });
    const controller = new AbortController();
    try {
      const marker = join(workdir, "cancel-marker");
      const running = adapter.run(bashRequest(`printf spawned > ${marker}`), {
        signal: controller.signal,
      });
      await waitFor(async () => (await outputFiles(parent)).length === 1);
      controller.abort();
      releaseSpawn();
      const result = await running;
      assert.equal(result.status, "cancelled");
      await assert.rejects(readFile(marker), "取消后的 Bash 不能启动子进程");
      assert.deepEqual(await outputFiles(parent), [], "准备期取消必须删除本次新建的空文件");
      const roots = await readdir(parent);
      assert.equal(roots.length, 1, "共享 tmp 根跨会话复用，不能整体递归删除");
    } finally {
      releaseSpawn();
      await adapter.close?.();
    }
  });
});

describe("Bash output path handoff", () => {
  it("keeps one path for explicit background bash and its TaskOutput read", async () => {
    const parent = tempParent("background");
    await mkdir(parent, { recursive: true });
    const adapter = new NodeExecutionAdapter({
      outputRootDir: artifacts,
      bashOutputTempDir: parent,
    });
    try {
      const started = await adapter.start(bashRequest("printf background-output"));
      assert.ok(started.outputPath);
      assert.equal(started.stdoutPersistedOutputPath, started.outputPath);
      const snapshot = await adapter.waitForBackgroundTask(started.taskId);
      assert.equal(snapshot?.outputPath, started.outputPath);
      const read = await adapter.readBackgroundBashOutput(started.taskId, "session-temp-output");
      assert.equal(read.kind, "output");
      if (read.kind === "output") {
        assert.equal(read.outputPath, started.outputPath);
        assert.equal(read.output, "background-output");
      }
      assert.equal(await readFile(started.outputPath, "utf8"), "background-output");
    } finally {
      await adapter.close?.();
    }
  });

  it("keeps the same path when a foreground command hands off to background on timeout", async () => {
    const parent = tempParent("handoff");
    await mkdir(parent, { recursive: true });
    const adapter = new NodeExecutionAdapter({
      outputRootDir: artifacts,
      bashOutputTempDir: parent,
    });
    try {
      const outcome = await adapter.runBashWithBackgroundLifecycle(
        bashRequest("printf head; sleep 1; printf tail", { timeoutMs: 200 }),
        { mode: "auto_on_timeout" },
      );
      assert.equal(outcome.kind, "backgrounded");
      if (outcome.kind !== "backgrounded") return;
      const path = outcome.task.outputPath;
      assert.ok(path);
      assert.equal(outcome.task.stdoutPersistedOutputPath, path);
      const snapshot = await adapter.waitForBackgroundTask(outcome.task.taskId);
      assert.equal(snapshot?.outputPath, path);
      assert.equal(await readFile(path, "utf8"), "headtail");
    } finally {
      await adapter.close?.();
    }
  });
});
