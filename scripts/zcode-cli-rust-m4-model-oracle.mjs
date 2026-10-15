// M4 real TS oracle: the Node test owns a loopback HTTP fixture; the real
// TypeScript adapter (`AiSdkModelAdapter`) and the Rust `model_fixture` example
// each connect to their own instance with the same scripted responses. This
// file is the only mock owner — no Rust fixture feature, no copied adapter.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { modelConfig, modelOptions } from "./ci/fixtures/local-model-config.mjs";

const { AiSdkModelAdapter } = await tsImport(
  "../apps/zcode-cli/packages/adapters/src/model/runner.ts",
  import.meta.url,
);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUST_MANIFEST = join(ROOT, "apps/zcode-cli-rust/Cargo.toml");

/** Only loopback endpoints are allowed; the oracle never talks to a real host. */
export function assertLoopbackEndpoint(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error(`M4 oracle rejects non-loopback endpoint: ${baseUrl}`);
  }
}

/** Build the example once; the spawned process then runs with an empty env. */
export function buildRustExample() {
  return runProcess(
    "cargo",
    [
      "build",
      "--offline",
      "--locked",
      "--manifest-path",
      RUST_MANIFEST,
      "--example",
      "model_fixture",
    ],
    { env: process.env, timeoutMs: 600_000, label: "cargo build model_fixture" },
  );
}

function rustExamplePath() {
  const suffix = process.platform === "win32" ? ".exe" : "";
  return join(ROOT, `apps/zcode-cli-rust/target/debug/examples/model_fixture${suffix}`);
}

/**
 * Start a scripted loopback fixture and run `fn` against it. `script(index,
 * request)` returns `{status, sse, headers, body}`. The fixture records every
 * accepted TCP connection (`stats.accepted`) and every fully read request
 * (`stats.complete`), and always closes in `finally`. Responses force
 * `Connection: close` so each request owns its connection; a keep-alive client
 * cannot make `accepted` differ from `complete` in the asserted cases.
 */
export async function withModelFixture(
  script,
  fn,
  { timeoutMs = 20_000, label = "M4 fixture" } = {},
) {
  const requests = [];
  const stats = { accepted: 0, complete: 0 };
  const handlerErrors = [];
  const acceptedWaiters = new Set();
  let closing = false;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const entry = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(entry);
      stats.complete += 1;
      const spec = script(requests.length - 1, entry);
      if (!spec) {
        res.writeHead(500, { "Content-Type": "text/plain", Connection: "close" });
        res.end("M4 fixture script exhausted");
        return;
      }
      const { status = 200, sse = false, headers = {}, body = "" } = spec;
      res.writeHead(status, {
        "Content-Type": sse ? "text/event-stream" : "application/json",
        ...headers,
        // 强制每个请求独占连接：TS provider 的回环连接可能 keep-alive，
        // accepted 会少于 complete；关闭后两个计数才可分别断言。
        Connection: "close",
      });
      res.end(body);
    } catch (error) {
      // teardown/closeAllConnections 会中止仍在读 body 的请求；这些连接级 abort
      // 不是 fixture 失败，捕获它们避免 async handler 产生 unhandled rejection。
      if (closing || req.aborted || res.destroyed || isConnectionAbort(error)) return;
      handlerErrors.push(error);
      // 让发起请求的一端尽快失败，而不是等整个 fixture deadline。
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(500, { "Content-Type": "text/plain", Connection: "close" });
        res.end(`M4 fixture handler error: ${error?.message ?? error}`);
      }
    }
  });
  server.on("connection", () => {
    stats.accepted += 1;
    for (const notify of acceptedWaiters) notify();
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const guard = setTimeout(() => {
    closing = true;
    server.closeAllConnections();
  }, timeoutMs);
  guard.unref?.();

  const origin = `http://127.0.0.1:${server.address().port}`;
  /** Resolve once the fixture has accepted `count` TCP connections; bounded. */
  const waitForAccepted = (count) =>
    new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        acceptedWaiters.delete(notify);
        reject(
          new Error(
            `${label} timed out waiting for ${count} accepted connection(s), saw ${stats.accepted}`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      function notify() {
        if (stats.accepted < count) return;
        clearTimeout(timer);
        acceptedWaiters.delete(notify);
        resolvePromise();
      }
      acceptedWaiters.add(notify);
      notify();
    });

  let result;
  let fnError;
  try {
    result = await fn({ origin, requests, stats, waitForAccepted });
  } catch (error) {
    fnError = error;
  } finally {
    clearTimeout(guard);
    closing = true;
    server.closeAllConnections();
    await closeServer(server, timeoutMs, label);
  }
  // 主流程失败优先抛出；否则把 handler 里记录的真实错误暴露出来。
  if (fnError && handlerErrors.length > 0) {
    throw new AggregateError(
      [fnError, ...handlerErrors],
      `${label}: model run failed and fixture handlers reported errors`,
    );
  }
  if (fnError) throw fnError;
  if (handlerErrors.length > 0) throw handlerErrors[0];
  return result;
}

/** Bounded `server.close()` wait so a stuck socket cannot hang a case. */
async function closeServer(server, timeoutMs, label) {
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} server did not close within ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    server.close(() => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

/** Connection-level aborts from teardown are expected, not fixture failures. */
function isConnectionAbort(error) {
  if (!error) return false;
  const code = error.code ?? error.cause?.code;
  return (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    code === "ERR_STREAM_DESTROYED" ||
    error.name === "AbortError" ||
    error.name === "ResponseAborted"
  );
}

/** Real TS adapter stream over the fixture; returns the shared oracle shape. */
export async function runTsOracle({ api, baseUrl, messages, maxRetries = 0, timeoutMs = 15_000 }) {
  assertLoopbackEndpoint(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("M4 TS oracle timeout")), timeoutMs);
  try {
    const adapter = new AiSdkModelAdapter({
      env: {},
      retry: { maxAttempts: maxRetries + 1, baseDelayMs: 0, jitter: false },
    });
    const model = adapter.createModel({
      providerId: "fixture",
      modelId: "fixture-model",
      providerConfig: {
        group: "standard-personal",
        access: { type: "api-key", apiKey: "fixture-key" },
        api: { type: api, baseUrl },
      },
      modelConfig,
      options: modelOptions,
    });
    const events = [];
    try {
      for await (const event of model.streamText({ messages, abortSignal: controller.signal })) {
        events.push(event);
      }
    } catch (error) {
      return {
        ok: false,
        code: error?.code ?? error?.name,
        message: String(error?.message ?? error),
      };
    }
    return { ok: true, ...normalizeTsEvents(events) };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTsEvents(events) {
  let text = "";
  let reasoning = "";
  const deltas = [];
  let reason = null;
  for (const event of events) {
    if (event?.type === "text_delta") {
      text += event.text;
      deltas.push({ reasoning: false, text: event.text });
    } else if (event?.type === "reasoning_delta") {
      reasoning += event.text;
      deltas.push({ reasoning: true, text: event.text });
    } else if (event?.type === "finish") {
      // AI SDK 保留原始 finish reason；无 raw 时（Responses `other`）与 Rust 同为 null。
      reason = event.providerMetadata?.rawFinishReason ?? null;
    }
  }
  return { text, reasoning, reason, events: deltas };
}

/** Rust `model_fixture` example over the fixture; empty env, temporary HOME. */
export async function runRustOracle({
  api,
  baseUrl,
  messages,
  maxRetries = 0,
  timeoutMs = 15_000,
}) {
  assertLoopbackEndpoint(baseUrl);
  const home = await mkdtemp(join(tmpdir(), "zcode-rust-m4-model-home-"));
  const config = {
    providerId: "fixture",
    modelId: "fixture-model",
    reasoningLevel: "none",
    baseUrl,
    apiType: api,
    retry: { maxRetries, baseDelayMs: 0, jitter: false },
    streamIdleTimeoutMs: 5_000,
  };
  try {
    const stdout = await runProcess(rustExamplePath(), [], {
      // 空环境白名单：只给临时 HOME；example 自身使用空 RuntimeEnv，不读取它。
      env: { HOME: home },
      input: `${JSON.stringify({ config, messages })}\n`,
      timeoutMs,
      label: "model_fixture",
    });
    const line = stdout.trim().split("\n").at(-1);
    if (!line) throw new Error("model_fixture produced no output");
    return JSON.parse(line);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function runProcess(command, args, { env, input, timeoutMs, label }) {
  return new Promise((resolvePromise, reject) => {
    // POSIX 下 cargo build/run 会再派生 rustc，只杀直接子进程会遗留 rustc 继续写 target；
    // 放进独立进程组，超时时整组 SIGKILL。Windows 无进程组信号，退回直接杀子进程。
    const detached = process.platform !== "win32";
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"], detached });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // 进程组已退出或不可用时退回直接子进程。
        }
      }
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      // 超时后先 SIGKILL，再等 close 确认进程退出才 reject；
      // 调用方 finally 删除临时 HOME 时子进程已不在写。
      if (timedOut) {
        reject(new Error(`${label} timed out after ${timeoutMs}ms: ${stderr}`));
        return;
      }
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${label} exited ${code ?? signal}: ${stderr}`));
    });
    child.stdin?.on("error", () => {});
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}
