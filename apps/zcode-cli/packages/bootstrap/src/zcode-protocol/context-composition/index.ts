// context-composition（CLI bootstrap 部分）公开入口。
// 规格：.agents/specs/upstream-3.18-context-projection.md。
export { getConversationContextComposition } from "./handler.js";
export { subscribeSessionContextComposition } from "./tracker.js";
