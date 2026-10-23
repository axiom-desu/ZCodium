// 该文件仅是 runtime 内部方法接口的分片组合，保留原 AgentRuntimeTurnMethods 名称与结构；
// this:AgentRuntimeInternal 的既有边界未变，本次不代表 runtime 已解耦。
import type { TurnInputMethods } from "./internal-turn-methods/turn-input-methods.js";
import type { TurnCompactToolMethods } from "./internal-turn-methods/turn-compact-tool-methods.js";
import type { SessionPersistenceMethods } from "./internal-turn-methods/session-persistence-methods.js";

export interface AgentRuntimeTurnMethods
  extends TurnInputMethods, TurnCompactToolMethods, SessionPersistenceMethods {}
