// A Node (`zcode.cjs`) or Rust App Server over stdio for the cross-runtime checks: both
// share one HOME, session database and Provider Registry, so either continues the other's
// sessions (spec rust-m11-node-storage §11).
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createV4InteractionActor } from "./lib/zcode-cli-rust-v4-interaction-actor.mjs";
export {
  contentText,
  modelServer,
  prepareHome,
  transcript,
} from "./lib/zcode-cli-rust-interop-fixture.mjs";

const activeRuntimes = new Set();

export async function stopAllRuntimes() {
  const results = await Promise.allSettled([...activeRuntimes].map((runtime) => runtime.kill()));
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

/** One App Server process (`kind` is `node` or `rust`). */
export function startRuntime(kind, { bundle, binary, cwd, env, dataDir }) {
  const command = kind === "node" ? process.execPath : binary;
  const common = ["app-server", "--stdio", "--surface", "terminal", "--cwd", cwd];
  const args = kind === "node" ? [bundle, ...common] : [...common, "--data-dir", dataDir];
  const inherited = Object.fromEntries(
    ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    // 不继承用户 provider、token 或代理变量；所有用户数据目录均由临时 HOME 覆盖。
    env: { ...inherited, ...env, ZCODE_WORKSPACE_IDENTITY: cwd },
  });
  const frames = [];
  const pending = new Map();
  const acknowledgements = [];
  const asyncFailures = [];
  let serial = 0;
  let buffer = "";
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const frame = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      interactionActor.observeFrame(frame);
      if (frame.method === "session/requestRuntimePreferences" && frame.id !== undefined) {
        const result = {
          askUserQuestionAutoResolutionEnabled: true,
          nativeSearchEnhancementsEnabled: true,
          memoryEnabled: false,
        };
        child.stdin.write(`${JSON.stringify({ id: frame.id, result })}\n`);
        continue;
      }
      if (frame.method === "interaction/requestPermission" && frame.id !== undefined) {
        const params = frame.params ?? {};
        const interactionId = params.interactionId ?? params.requestId;
        const fixtureTool = ["Bash", "Read"].includes(params.toolName);
        // 有 ID 时保留 legacy RPC 等待；V4 resolveInteraction 会取消它并映射唯一答案。
        if (interactionId && fixtureTool) continue;
        const allow = fixtureTool;
        const result = {
          decision: allow ? "allow" : "deny",
          reason: allow ? "Legacy fixture permission callback" : "Interaction outside fixture",
        };
        child.stdin.write(`${JSON.stringify({ id: frame.id, result })}\n`);
        acknowledgements.push({
          method: frame.method,
          decision: result.decision,
          interactionId,
          toolName: params.toolName,
        });
        continue;
      }
      if (frame.id !== undefined && pending.has(frame.id) && frame.method === undefined) {
        const waiter = pending.get(frame.id);
        pending.delete(frame.id);
        acknowledgements.push({
          method: waiter.method,
          id: frame.id,
          result: frame.result,
          error: frame.error,
        });
        if (frame.error) waiter.reject(new Error(frame.error.message));
        else waiter.resolve(frame.result);
        continue;
      }
      frames.push(frame);
    }
  });
  const exited = once(child, "close");
  child.on("close", (code, signal) => {
    const error = new Error(
      `${kind} exited before RPC response (code=${code}, signal=${signal ?? "none"})`,
    );
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  const rpc = (method, params = {}) =>
    new Promise((resolveRpc, reject) => {
      if (child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed) {
        reject(new Error(`${kind} exited before RPC response`));
        return;
      }
      const id = ++serial;
      pending.set(id, { method, resolve: resolveRpc, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        const waiter = pending.get(id);
        if (!waiter) return;
        pending.delete(id);
        waiter.reject(error);
      });
    });
  const deltas = (from = 0) =>
    frames.slice(from).flatMap((frame) => frame.params?.frame?.payload?.deltas ?? []);
  const interactionActor = createV4InteractionActor({
    answer: async (sessionId, interactionId, toolName) => {
      const result = await rpc("v4/command", {
        commandId: randomUUID(),
        clientId: `interop-${kind}`,
        sessionId,
        type: "resolveInteraction",
        payload: { interactionId, answer: { optionId: "allowOnce" } },
        issuedAt: Date.now(),
      });
      if (result?.status !== "accepted")
        throw new Error(
          `${kind}: resolveInteraction ACK was not accepted: ${JSON.stringify(result)}`,
        );
      acknowledgements.push({
        method: "v4/command:resolveInteraction",
        interactionId,
        toolName,
        result,
      });
    },
    onError: (error) => asyncFailures.push(error),
  });
  const runtime = {
    kind,
    child,
    environment: { ...env },
    frames,
    rpc,
    get stderr() {
      return stderr;
    },
    deltas,
    get diagnosticFrames() {
      const events = frames.filter((frame) =>
        /terminal|permission|approval|tool/i.test(
          `${frame.method ?? ""} ${JSON.stringify(frame.params?.frame?.payload ?? frame.params ?? {})}`,
        ),
      );
      return [...events, ...acknowledgements];
    },
    /** A v4 command; `extra` adds envelope members such as `baseRevision`. */
    command(type, sessionId, payload = {}, commandId = randomUUID(), extra = {}) {
      return rpc("v4/command", {
        commandId,
        clientId: `interop-${kind}`,
        sessionId,
        type,
        payload,
        issuedAt: Date.now(),
        ...extra,
      });
    },
    subscribe(sessionId) {
      return rpc("v4/conversation/subscribe", {
        topic: `conversation/${sessionId}`,
        connectionId: `interop-${kind}`,
        clientMode: "desktop-continuous",
      });
    },
    assertHealthy() {
      if (asyncFailures.length)
        throw new Error(`${kind}: async driver callback failed: ${String(asyncFailures[0])}`);
    },
    /** Waits for a delta after frame `from` matching `test` (default 20 s). */
    async until(test, from = 0, timeoutMs = 20_000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        runtime.assertHealthy();
        const found = deltas(from).find(test);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`${kind}: timed out; stderr: ${stderr.slice(-800)}`);
    },
    /** Waits for the conversation snapshot frame sent after frame `from`. */
    async snapshot(from = 0, timeoutMs = 20_000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        runtime.assertHealthy();
        const found = frames
          .slice(from)
          .findLast((frame) => frame.params?.frame?.payload?.kind === "snapshot");
        if (found) return found.params.frame.payload.snapshot;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`${kind}: no snapshot; stderr: ${stderr.slice(-800)}`);
    },
    /** Sends a prompt and waits for its turn to end; the control patch. */
    async turn(sessionId, text) {
      const from = frames.length;
      const ack = await runtime.command("sendText", sessionId, { text });
      if (ack.status !== "accepted") throw new Error(`${kind}: ${JSON.stringify(ack)}`);
      const done = await runtime.until(
        (d) =>
          ["completedSuccess", "error", "completedInterrupted"].includes(d.patch?.control?.phase),
        from,
      );
      if (done.patch.control.phase !== "completedSuccess")
        throw new Error(`${kind}: ${JSON.stringify(done.patch.control.lastError)}`);
      return ack;
    },
    async close() {
      child.stdin.end();
      let timer;
      try {
        const [code] = await Promise.race([
          exited,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${kind} close deadline exceeded`)), 5_000);
          }),
        ]);
        activeRuntimes.delete(runtime);
        runtime.assertHealthy();
        if (code !== 0) throw new Error(`${kind} exited ${code}: ${stderr.slice(-800)}`);
      } catch (error) {
        await runtime.kill();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
    async kill() {
      if (process.platform === "win32")
        throw new Error(
          "unsupported_platform: POSIX process-group fixture cleanup is unavailable on Windows",
        );
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // 整个进程组可能已退出。
      }
      let timer;
      try {
        await Promise.race([
          exited,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`${kind} SIGKILL cleanup deadline exceeded`)),
              5_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
        activeRuntimes.delete(runtime);
      }
    },
  };
  activeRuntimes.add(runtime);
  return runtime;
}
