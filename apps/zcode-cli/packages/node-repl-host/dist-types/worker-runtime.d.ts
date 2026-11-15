import { type NodeReplRequestMeta, type NodeReplRunResult } from "@zcode/core/repl";
import { type NodeReplBrowserBrokerConnection } from "./browser-bridge.js";
import type { NodeReplBrowserBrokerUpstream } from "./call-ledger/contract.js";
import { type NodeReplCuaBrokerConnection } from "./cua-bridge.js";
export interface NodeReplExecuteInput {
    code: string;
    requestMeta: NodeReplRequestMeta;
    signal: AbortSignal;
    syncTimeoutMs: number;
    cuaBroker?: NodeReplCuaBrokerConnection;
    browserBroker?: NodeReplBrowserBrokerConnection;
}
export type NodeReplExecutor = (input: NodeReplExecuteInput) => Promise<NodeReplRunResult>;
/**
 * 测试与同进程嵌入入口使用同一条执行逻辑；生产 stdio 默认在一次性 Worker 中调用它。
 */
export declare function createInProcessNodeReplExecutor(): NodeReplExecutor;
export declare function executeJsInWorker(input: NodeReplExecuteInput): Promise<NodeReplRunResult>;
export declare function browserBrokerUpstreamFromEnvironment(env: NodeJS.ProcessEnv): NodeReplBrowserBrokerUpstream | undefined;
//# sourceMappingURL=worker-runtime.d.ts.map