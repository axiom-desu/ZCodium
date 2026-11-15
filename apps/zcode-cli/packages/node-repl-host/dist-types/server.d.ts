import { Server } from "@modelcontextprotocol/server";
import { type ComputerUseRuntime } from "@zcode/zcode-cua";
import { type NodeReplBrowserBrokerUpstream } from "./call-ledger/contract.js";
import { installNodeReplProcessGuards, installNodeReplShutdownTriggers } from "./process-lifecycle.js";
import { createInProcessNodeReplExecutor, type NodeReplExecutor } from "./worker-runtime.js";
export declare const NODE_REPL_MCP_PROCESS_TITLE = "zcode-node-repl-mcp";
export type { NodeReplExecuteInput, NodeReplExecutor } from "./worker-runtime.js";
export { createInProcessNodeReplExecutor };
export interface NodeReplMcpRuntime {
    dispose(): void;
    server: Server;
}
export declare function setNodeReplMcpProcessTitle(target?: {
    title: string;
}): void;
export declare function createNodeReplMcpRuntime(input?: {
    executeJs?: NodeReplExecutor;
    cuaRuntime?: ComputerUseRuntime;
    /** ZCode 主进程浏览器 broker 的地址和 token；默认从环境变量读取（测试注入假 broker）。 */
    browserBrokerUpstream?: NodeReplBrowserBrokerUpstream;
    writeStderr?: (text: string) => void;
}): NodeReplMcpRuntime;
export { installNodeReplProcessGuards, installNodeReplShutdownTriggers };
export declare function main(): Promise<void>;
/**
 * 按平台装配 Computer Use 运行时：
 * - Linux 老 GNOME 自动组装 compat（探测 shell/portal/WinRects 版本）；
 * - macOS / Linux 新合成器 / X11 走 cua-driver 原生。
 * 仅当 env 指定 driver socket / embedded 时才构造；driver 缺失保持 fail-closed。
 */
export declare function captureComputerUseRuntimeFromEnvironment(env?: NodeJS.ProcessEnv): Promise<ComputerUseRuntime | undefined>;
//# sourceMappingURL=server.d.ts.map