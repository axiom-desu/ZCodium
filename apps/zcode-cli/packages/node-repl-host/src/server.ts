import { safeLogArgs } from "@zcode/shared";
import { isMainThread } from "node:worker_threads";
import { INVALID_PARAMS, Server, type Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { JsInputJsonSchema } from "@zcode/contracts/tools/node-repl";
// 值导入必须走 @zcode/core/repl 这条深路径：barrel 会把 core 的整张图拖进 bundle
// （tool handlers → @zcode/dynamic-workflow → typescript，实测 21.7MB 且求值即崩
// ERR_AMBIGUOUS_MODULE_SYNTAX）。宿主只需要 REPL 会话本身。
// 类型也一并从 /repl 取：总入口的顶层副作用会把 Agent、Bash 注册表和工作流编译器
// 打入每个 REPL Worker，Worker 会重复承担这份开销。
import type { NodeReplRequestMeta } from "@zcode/core/repl";
import { type ComputerUseRuntime } from "@zcode/zcode-cua";
import { assembleComputerUseRuntimeAsync, probeGnomeEnvironment } from "@zcode/zcode-cua/platform";
import {
  createNodeReplBrowserBrokerProxy,
  createNodeReplCallLedger,
  type NodeReplBrowserBrokerUpstream,
} from "./call-ledger/contract.js";
import { createNodeReplCuaBroker, type NodeReplCuaBroker } from "./cua-broker.js";
import { createNoProgressGuard } from "./no-progress-guard.js";
import {
  isDirectMcpEntrypoint,
  installNodeReplProcessGuards,
  installNodeReplShutdownTriggers,
} from "./process-lifecycle.js";
import { toMcpRunResult } from "./result.js";
import {
  JS_TOOL_DESCRIPTION,
  NODE_REPL_DEFAULT_TIMEOUT_MS,
  NODE_REPL_SERVER_INSTRUCTIONS,
  NODE_REPL_SERVER_VERSION,
} from "./tool-contract.js";
import {
  browserBrokerUpstreamFromEnvironment,
  createInProcessNodeReplExecutor,
  executeJsInWorker,
  type NodeReplExecuteInput,
  type NodeReplExecutor,
} from "./worker-runtime.js";
import { z } from "zod";

const MAX_SYNC_TIMEOUT_MS = 120_000;
const UNTRUSTED_SESSION_KEY = "__unscoped__";
export const NODE_REPL_MCP_PROCESS_TITLE = "zcode-node-repl-mcp";
const jsInputSchema = z
  .object({
    code: z.string(),
    timeout_ms: z.number().int().min(1).max(MAX_SYNC_TIMEOUT_MS).optional(),
    // tools/list 对新调用强制 title，但执行层必须继续接受旧 provider 和历史回放的 code-only 输入。
    title: z.string().min(1).max(120).optional(),
  })
  .strict();
const requestContextSchema = z
  .object({
    parent_span_id: z.string().optional(),
    runtime_scope: z.enum(["main", "subagent"]).default("main"),
    session_id: z.string().trim().min(1).optional(),
    span_id: z.string().optional(),
    trace_id: z.string().optional(),
    turn_id: z.string().optional(),
    workspace_identity: z.string().optional(),
    workspace_key: z.string().optional(),
    workspace_path: z.string().optional(),
    remote_session_id: z.string().optional(),
    client_mode: z.string().optional(),
    delivery_kind: z.string().optional(),
  })
  .passthrough();

const tools: Tool[] = [
  {
    name: "js",
    description: JS_TOOL_DESCRIPTION,
    // host MCP 曾手写出 title optional 的模型合同，和 built-in 合同分叉后 UI 只能显示固定完成文案。
    inputSchema: JsInputJsonSchema as Tool["inputSchema"],
  },
];

export type { NodeReplExecuteInput, NodeReplExecutor } from "./worker-runtime.js";
export { createInProcessNodeReplExecutor };

export interface NodeReplMcpRuntime {
  dispose(): void;
  server: Server;
}

export function setNodeReplMcpProcessTitle(target: { title: string } = process): void {
  target.title = NODE_REPL_MCP_PROCESS_TITLE;
}

export function createNodeReplMcpRuntime(
  input: {
    executeJs?: NodeReplExecutor;
    cuaRuntime?: ComputerUseRuntime;
    /** ZCode 主进程浏览器 broker 的地址和 token；默认从环境变量读取（测试注入假 broker）。 */
    browserBrokerUpstream?: NodeReplBrowserBrokerUpstream;
    writeStderr?: (text: string) => void;
  } = {},
): NodeReplMcpRuntime {
  const executeJs = input.executeJs ?? executeJsInWorker;
  const writeStderr = input.writeStderr ?? ((text: string) => void process.stderr.write(text));
  const noProgressGuard = createNoProgressGuard();
  const cuaRuntime = input.cuaRuntime;
  // 本次调用的可信事实只由主线程的两个 broker 记进账本（20-node-repl-call-ledger.md）。
  const ledger = createNodeReplCallLedger();
  const cuaBroker: NodeReplCuaBroker | undefined = cuaRuntime
    ? createNodeReplCuaBroker({ runtime: cuaRuntime, ledger, platform: process.platform })
    : undefined;
  const browserBrokerUpstream =
    input.browserBrokerUpstream ?? browserBrokerUpstreamFromEnvironment(process.env);
  const browserBrokerProxy = browserBrokerUpstream
    ? createNodeReplBrowserBrokerProxy({
        ledger,
        upstream: browserBrokerUpstream,
        platform: process.platform,
      })
    : undefined;
  const queues = new Map<string, Promise<void>>();
  const activeCalls = new Set<AbortController>();
  let disposed = false;

  const serialized = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const next = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    queues.set(key, next);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (queues.get(key) === next) queues.delete(key);
    }
  };

  const server = new Server(
    { name: "node_repl", version: NODE_REPL_SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: NODE_REPL_SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler("tools/list", async () => ({ tools }));
  server.setRequestHandler("tools/call", async (request, extra) => {
    if (disposed) throw new Error("node_repl runtime is disposed");
    const name = request.params.name;
    const requestMeta = buildRequestMeta(extra.mcpReq._meta);
    const sessionKey = requestSessionKey(requestMeta);
    if (name === "js") {
      const args = parseToolInput(jsInputSchema, request.params.arguments, name);
      return await serialized(sessionKey, async () => {
        if (!args.code) {
          return {
            content: [{ type: "text" as const, text: "js expects non-empty JavaScript source" }],
            isError: true,
          };
        }
        const callController = new AbortController();
        activeCalls.add(callController);
        const timeoutMs = args.timeout_ms ?? NODE_REPL_DEFAULT_TIMEOUT_MS;
        const callMeta = { ...requestMeta, ...(args.title ? { title: args.title } : {}) };
        const call = ledger.open(callMeta);
        try {
          const signal = AbortSignal.any([
            extra.mcpReq.signal,
            callController.signal,
            AbortSignal.timeout(timeoutMs),
          ]);
          const run = await executeJs({
            code: args.code,
            requestMeta: callMeta,
            signal,
            syncTimeoutMs: Math.min(timeoutMs, MAX_SYNC_TIMEOUT_MS),
            ...(cuaBroker
              ? { cuaBroker: { socketPath: cuaBroker.connection.socketPath, token: call.token } }
              : {}),
            ...(browserBrokerProxy
              ? {
                  browserBroker: {
                    socketPath: browserBrokerProxy.connection.socketPath,
                    token: call.token,
                  },
                }
              : {}),
          });
          const result = toMcpRunResult(run, call.facts);
          const hint = noProgressGuard.observe({ requestMeta, code: args.code, result });
          if (hint) {
            result.content.push({ type: "text", text: hint.text });
            writeStderr(
              `[node_repl] no-progress hint kind=${hint.kind} count=${hint.count} ` +
                `session=${String(requestMeta.session_id)} turn=${String(requestMeta.turn_id)}\n`,
            );
          }
          return result;
        } finally {
          call.close();
          activeCalls.delete(callController);
        }
      });
    }
    invalidParams(`Tool ${name} not found`);
  });

  return {
    server,
    dispose: () => {
      disposed = true;
      for (const controller of activeCalls) controller.abort();
      activeCalls.clear();
      queues.clear();
      void cuaBroker?.close();
      void browserBrokerProxy?.close();
      void cuaRuntime?.dispose();
    },
  };
}

function parseToolInput<T>(schema: z.ZodType<T>, input: unknown, toolName: string): T {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  invalidParams(`${toolName}: ${issue?.message ?? "invalid arguments"}`);
}

function invalidParams(message: string): never {
  throw Object.assign(new Error(message), { code: INVALID_PARAMS });
}

function buildRequestMeta(meta: Record<string, unknown> | undefined): NodeReplRequestMeta {
  const parsed = requestContextSchema.safeParse(meta?.["com.zcode/request-context"]);
  // 安全边界：顶层 MCP _meta 是第三方可扩展字段，不能成为 ZCode session 路由凭据。
  // 只有 host client 写入的命名空间会进入 Browser bridge；旧 client 的普通 JS 仍可执行。
  return parsed.success ? parsed.data : {};
}

function requestSessionKey(meta: NodeReplRequestMeta): string {
  const sessionId = meta.session_id;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId : UNTRUSTED_SESSION_KEY;
}

export { installNodeReplProcessGuards, installNodeReplShutdownTriggers };

export async function main(): Promise<void> {
  setNodeReplMcpProcessTitle();
  const runtimes = new Set<NodeReplMcpRuntime>();
  // 官方 plugin host 在 main() 返回后会清除短暂恢复的 Helper 凭据，而
  // serveStdio 的 server factory 要到 MCP initialize 时才执行。过去在 factory 内读取
  // process.env，必然得到空值，导致 node_repl 永久把 Computer Use 判为 unavailable。
  // 这里在 main() 生命周期内先捕获 runtime；Worker 只收到二次 bridge token，
  // 不会接触 Helper 的原始 socket/token。
  const computerUseRuntime = await captureComputerUseRuntimeFromEnvironment();
  const handle = serveStdio(
    () => {
      const runtime = createNodeReplMcpRuntime({ cuaRuntime: computerUseRuntime });
      runtimes.add(runtime);
      return runtime.server;
    },
    { legacy: "reject" },
  );
  let shutdownStarted = false;
  const shutdown = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    for (const runtime of runtimes) runtime.dispose();
    void handle
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  installNodeReplProcessGuards({
    onOutputClosed: shutdown,
    process,
    writeStderr: (text) => process.stderr.write(text),
  });
  installNodeReplShutdownTriggers({ process, shutdown, stdin: process.stdin });
}

/**
 * 按平台装配 Computer Use 运行时：
 * - Linux 老 GNOME 自动组装 compat（探测 shell/portal/WinRects 版本）；
 * - macOS / Linux 新合成器 / X11 走 cua-driver 原生。
 * 仅当 env 指定 driver socket / embedded 时才构造；driver 缺失保持 fail-closed。
 */
export async function captureComputerUseRuntimeFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ComputerUseRuntime | undefined> {
  // 只认 cua-driver 的 socket；旧闭源 Helper 的 broker socket 不是 driver endpoint，
  // 连同名 fallback 一并移除（见 computer-use-runtime.md P2）。
  const socketPath = env.ZCODE_CUA_DRIVER_SOCKET?.trim();
  const enabled = Boolean(socketPath) || env.ZCODE_CUA_DRIVER_EMBEDDED === "1";
  if (!enabled) return undefined;
  const { runtime } = await assembleComputerUseRuntimeAsync({
    env,
    socketPath,
    probes: process.platform === "linux" ? probeGnomeEnvironment() : {},
  });
  return runtime;
}

if (isMainThread && (await isDirectMcpEntrypoint(import.meta.url, process.argv[1]))) {
  void main().catch((error) => {
    process.stderr.write(`node_repl MCP server failed: ${JSON.stringify(safeLogArgs([error]))}\n`);
    process.exitCode = 1;
  });
}
