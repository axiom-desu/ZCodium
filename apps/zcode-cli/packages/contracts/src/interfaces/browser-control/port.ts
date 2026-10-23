import type { BrowserBackendDescriptor } from "./context.js";
import type {
  BrowserCommandResult,
  BrowserControlExecuteInput,
  BrowserControlListInput,
} from "./results.js";

export type BrowserChildSessionTabOwner = "child" | "parent";

export interface BrowserControlPort {
  /** 只返回完成握手且当前 context 可达的 backend，不允许伪造 stub。 */
  list(input: BrowserControlListInput): Promise<BrowserBackendDescriptor[]>;
  execute(input: BrowserControlExecuteInput): Promise<BrowserCommandResult>;
  /** turn 结束时取消该 turn 尚未完成的 IAB 请求，不跨 session 清 tab。 */
  turnEnded?(input: BrowserControlListInput): Promise<void>;
  /** session 关闭时释放 browser guest、pending request 与 lease。 */
  closeSession?(input: BrowserControlListInput): Promise<void>;
  /**
   * 为一个客户端不认识的子会话派生端口：workspace / clientMode 按 parentSessionId 的会话解析。
   *
   * - `tabOwner: "child"`（默认，dwf 子代理）：tab 归属是子会话自己的 sessionId；派生端口的
   *   closeSession 连 tab 一起关，并结束这份登记。
   * - `tabOwner: "parent"`（core Agent 子代理）：下发的 sessionId 换成父会话，子代理与当前对话
   *   共用同一组 tab（桌面据此展开面板、tabs.list 列出对话全部 tab）；派生端口的 turnEnded /
   *   closeSession 不向桌面发生命周期，tab 交给父会话自己的生命周期管理，closeSession 只结束登记。
   *
   * 登记结束后该子会话的请求与从未登记的一样被拒。
   *
   * 缺席表示实现不按客户端会话校验 sessionId（如 CLI headless CDP），子会话直接用本端口。
   * 见 `.agents/specs/browser-subagent-shared-tabs.md`。
   */
  forChildSession?(input: {
    childSessionId: string;
    parentSessionId: string;
    tabOwner?: BrowserChildSessionTabOwner;
  }): BrowserControlPort;
}
