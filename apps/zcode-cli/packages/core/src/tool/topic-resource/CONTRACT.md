# topic-resource-tool

`ReadTopicResource` 读取当前任务**已接纳**话题快照里的一个资源索引项（A1、A2…），是 bot 历史附件
重新下载的唯一入口。官方语义见 `.cache/upstream-3.18.2` 的 `core/src/tool/topic-resource`，
本仓差异见 `.agents/specs/upstream-3.18-t5-topic-resource.md`。

- 公开面：`contract.ts` 的工具名与输入输出 schema；`../handlers/read-topic-resource.ts` 的
  ToolEntry。`reader.ts` 是内部实现。
- 输入 `{ inputId?, messageId, index? }`，`index` 缺省为 0；**strict**，URL、路径、会话 id、
  群 id 等字段一律拒绝。输出 `{ status, path, fileName, mime, bytes, messageId, index }`。
- 任务归属只来自 `ToolExecutionContext.sessionId`。接纳授权与资源索引边界由 Host
  `TopicResourcePort` 的 bot 接纳归档裁决；本层只额外要求 `inputId` 出现在本任务已持久化的
  输入事实里（存在时）。
- 副作用：经 Host 端口读取后写入会话保留期的托管二进制 artifact，因此不是只读；
  `sideEffectScope: "session"`，无需审批，超时 5 分钟。
- 注册：运行时注入 `topicResourcePort` 才注册。缺省即本执行面没有 bot 接纳事实（独立 CLI、
  子代理），不伪造本地下载。
- 错误：端口缺失、未接纳、跨任务、资源未索引、大小或编码不符、取消，都抛错，不回退到其他来源。
