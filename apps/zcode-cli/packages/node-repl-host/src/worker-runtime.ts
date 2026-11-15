// ============================================================
// node_repl 的执行层：同进程执行器、一次性 Worker 与 Worker 入口
// ============================================================
// 从 server.ts 拆出来（本仓源码上限 400 行）：MCP 工具面、账本和 broker 留在 server.ts，
// 执行/Worker 生命周期放在这里。两者共用同一条执行逻辑——生产 stdio 默认在一次性 Worker 中
// 调用它，从而连 Node 的模块缓存都随调用一起销毁。

import { resolve } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { NodeReplSession, type NodeReplRequestMeta, type NodeReplRunResult } from "@zcode/core/repl";
// 只加载 broker 协议常量；shared 总入口会初始化无关领域的 schema。
import {
  NODE_REPL_BROWSER_BROKER_SOCKET_ENV,
  NODE_REPL_BROWSER_BROKER_TOKEN_ENV,
} from "@zcode/shared/node-repl-browser-broker";
import {
  createBrowserBridgeGlobals,
  type ActiveNodeReplCall,
  type NodeReplBrowserBrokerConnection,
} from "./browser-bridge.js";
import type { NodeReplBrowserBrokerUpstream } from "./call-ledger/contract.js";
import {
  createComputerUseBridgeGlobals,
  type ActiveCuaNodeReplCall,
  type NodeReplCuaBrokerConnection,
} from "./cua-bridge.js";

const WORKER_KIND = "zcode-node-repl-call";
const pluginRoot = process.env.ZCODE_PLUGIN_ROOT ?? process.cwd();
// CUA 与 Browser Use 共用 node_repl host，但文档和 native 依赖必须按领域隔离；
// 否则 CUA skill 会因为 host root 恰好来自 Browser Use 而再次产生隐式依赖。
const browserDocumentationRoot = resolve(pluginRoot, "docs");
const cuaDocumentationRoot = resolve(process.env.ZCODE_CUA_PLUGIN_ROOT ?? pluginRoot, "docs");

export interface NodeReplExecuteInput {
  code: string;
  requestMeta: NodeReplRequestMeta;
  signal: AbortSignal;
  syncTimeoutMs: number;
  cuaBroker?: NodeReplCuaBrokerConnection;
  browserBroker?: NodeReplBrowserBrokerConnection;
}

export type NodeReplExecutor = (input: NodeReplExecuteInput) => Promise<NodeReplRunResult>;

interface WorkerCallData {
  code: string;
  kind: typeof WORKER_KIND;
  requestMeta: NodeReplRequestMeta;
  syncTimeoutMs: number;
  cuaBroker?: NodeReplCuaBrokerConnection;
  browserBroker?: NodeReplBrowserBrokerConnection;
}

/**
 * 测试与同进程嵌入入口使用同一条执行逻辑；生产 stdio 默认在一次性 Worker 中调用它。
 */
export function createInProcessNodeReplExecutor(): NodeReplExecutor {
  return async (input) => {
    let activeCall: ActiveNodeReplCall | undefined;
    let activeCuaCall: ActiveCuaNodeReplCall | undefined;
    let session: NodeReplSession;
    const generation = 1;
    session = new NodeReplSession({
      injectedGlobals: () => ({
        ...createBrowserBridgeGlobals({
          broker: input.browserBroker,
          documentationRoot: browserDocumentationRoot,
          generation,
          getActiveCall: () => activeCall,
          session: () => session,
        }),
        ...createComputerUseBridgeGlobals({
          broker: input.cuaBroker,
          generation,
          getActiveCall: () => activeCuaCall,
          session: () => session,
          documentationRoot: cuaDocumentationRoot,
        }),
      }),
      restrictProcess: true,
    });
    activeCall = {
      generation,
      requestMeta: input.requestMeta,
      signal: input.signal,
    };
    activeCuaCall = {
      generation,
      requestMeta: input.requestMeta,
      signal: input.signal,
    };
    try {
      return await session.run(input.code, {
        requestMeta: input.requestMeta,
        signal: input.signal,
        syncTimeoutMs: input.syncTimeoutMs,
      });
    } finally {
      activeCall = undefined;
      activeCuaCall = undefined;
      session.dispose();
    }
  };
}

export async function executeJsInWorker(input: NodeReplExecuteInput): Promise<NodeReplRunResult> {
  if (input.signal.aborted) throw input.signal.reason;
  const data: WorkerCallData = {
    code: input.code,
    kind: WORKER_KIND,
    requestMeta: input.requestMeta,
    syncTimeoutMs: input.syncTimeoutMs,
    cuaBroker: input.cuaBroker,
    browserBroker: input.browserBroker,
  };
  const worker = new Worker(new URL(import.meta.url), {
    workerData: data,
    env: workerEnvironment(),
  });
  return await new Promise<NodeReplRunResult>((resolveRun, rejectRun) => {
    let settled = false;
    const cleanup = () => {
      input.signal.removeEventListener("abort", onAbort);
      worker.removeAllListeners();
    };
    const finish = (error?: unknown, result?: NodeReplRunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate().catch(() => undefined);
      if (error !== undefined) rejectRun(error);
      else if (result) resolveRun(result);
      else rejectRun(new Error("node_repl worker returned no result"));
    };
    const onAbort = () => finish(input.signal.reason ?? new DOMException("aborted", "AbortError"));
    input.signal.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: unknown) => finish(undefined, message as NodeReplRunResult));
    worker.once("error", finish);
    worker.once("exit", (code) => {
      if (!settled)
        finish(new Error(`node_repl worker exited before returning a result (${code})`));
    });
    if (input.signal.aborted) onAbort();
  });
}

export function browserBrokerUpstreamFromEnvironment(
  env: NodeJS.ProcessEnv,
): NodeReplBrowserBrokerUpstream | undefined {
  const socketPath = env[NODE_REPL_BROWSER_BROKER_SOCKET_ENV]?.trim();
  const token = env[NODE_REPL_BROWSER_BROKER_TOKEN_ENV]?.trim();
  return socketPath && token ? { socketPath, token } : undefined;
}

/**
 * Worker 的环境去掉上游浏览器 broker 的地址和 token：只有主线程代理需要它们，Worker 只拿本次调用的
 * token。这只是缩小暴露面，不是可信边界——cell 仍可能从进程的初始环境读到它们，那样绕过代理的调用
 * 只会少记、不会多记（20-node-repl-call-ledger.md「可信边界」）。
 */
function workerEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[NODE_REPL_BROWSER_BROKER_SOCKET_ENV];
  delete env[NODE_REPL_BROWSER_BROKER_TOKEN_ENV];
  return env;
}

function isWorkerCallData(value: unknown): value is WorkerCallData {
  if (!value || typeof value !== "object") return false;
  return (value as { kind?: unknown }).kind === WORKER_KIND;
}

if (!isMainThread && isWorkerCallData(workerData)) {
  const execute = createInProcessNodeReplExecutor();
  const controller = new AbortController();
  void execute({
    code: workerData.code,
    requestMeta: workerData.requestMeta,
    signal: controller.signal,
    syncTimeoutMs: workerData.syncTimeoutMs,
    cuaBroker: workerData.cuaBroker,
    browserBroker: workerData.browserBroker,
  })
    .then((result) => parentPort?.postMessage(result))
    .catch((error) => {
      parentPort?.postMessage({
        logs: "",
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      } satisfies NodeReplRunResult);
    });
}
