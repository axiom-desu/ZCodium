# remote-input-prediction

手机远控输入预测（ghost hint）的线格式与只读查询契约。

- `contract.ts` 是线格式唯一定义：请求/响应都严格校验，候选 `text` 是接在草稿后的续写。
- `decision !== "show"` 时手机不得展示；`cancelled` 直接丢弃；迟到响应按 `requestId` 丢弃。
- 预测不是会话状态：不写 transcript、不持久化、不进入 accepted 队列、不进入重播。
- `cancelled`/`unavailable` 不缓存；`suppress_*` 缓存结果但不缓存模型失败。
- 本模块不做 IO；实现入口在清单 `publicEntrypoints` 指明的 services/CLI 文件中。
