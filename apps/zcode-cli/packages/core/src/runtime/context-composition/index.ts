// context-composition（CLI core 部分）公开入口。
// 规格：.agents/specs/upstream-3.18-context-projection.md。
//
// 查询（getContextComposition）、失效通知（markContextCompositionChanged）与订阅是 runtime 对外
// 的三个面；分类/状态/预演只由 runtime 内部与 methods 装配引用。
export { getContextComposition } from "./query.js";
export {
  markContextCompositionChanged,
  subscribeContextCompositionChanged,
} from "./state.js";
