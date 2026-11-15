# T5：ReadTopicResource（话题资源读取）语义搬运

官方固定源：`.cache/upstream-3.18.2`（`zai-org/ZCode@fec97590`）。参考实现：

- `apps/zcode-cli/packages/core/src/tool/topic-resource/{contract,reader,module,CONTRACT.md}`
- `apps/zcode-cli/packages/core/src/tool/handlers/read-topic-resource.ts`
- `apps/zcode-cli/packages/contracts/src/interfaces/topic-resource.port.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/topic-resource-port.ts`
- `packages/services/src/bots/{topicResource,topicHistoryAttachment}.ts`、`bots/topic-history-attachment/*`
- `packages/services/src/zcode-agent/{topicResourceBridge,topicResourceUpload}.ts`
- `packages/desktop/src/host/topic-resource-relay/*`

本仓起点：无 `ReadTopicResource`，无话题归档 owner，bot 入站只有单会话（无 group/topic thread）。

## 产品规则

1. 模型只提供 `{ inputId?, messageId, index? }`。禁止任何 URL、路径、会话 id、群 id、bot id、授权 id 输入。
   输入 schema `strict`，未知字段一律拒绝。
2. 只允许读取**当前任务已接纳（accepted）输入**里索引过的资源；其他会话、其他 workspace、
   未接纳或已撤销/过期/换代的快照一律拒绝。模型无法通过参数改变任务归属。
3. 读取必须经过 Host 已认证 bot 渠道：资源字节只用已配置来源（当前 `feishu`/`lark`）的原
   bot 能力下载，不使用新登录、官方云或第二 manager。provider 不支持时明确报不可用，不假称支持。
4. 下载结果写入会话保留期的托管二进制 artifact，返回受管路径；不把字节塞回模型文本。
5. 无 Host（无 `topicResourcePort`）即不注册该工具：CLI 自身没有 bot 接纳事实，不伪造本地实现。

## 状态所有者与事件顺序

单一 owner：`packages/services/src/bots/topicArchive.ts` 的 `BotsTopicArchive`
（文件 `bots-topic-archive.json`，`atomicWritePrivateTextFile` + `withFileLock`）。

```text
bot ingress(handleMessage) ──accept──> archive.admit(input)  (admission=accepted, 单调 generation)
                                          │
CLI session/send(inputId, 资源索引附件)     │  (模型看见 inputId/messageId/index)
                                          ▼
ReadTopicResource tool ──> bootstrap TopicResourcePort ──reverse RPC topic/resource/read──> Host
                                          │                     │
                                          │                     ├─ archive.lookup(taskId,workspace,input?)
                                          │                     ├─ 授权复核（bot/provider/群/凭据/代际）
                                          │                     ├─ provider.downloadTopicResource（大小/重定向/取消）
                                          │                     └─ 再次复核代际，v4 attachment 回传 CLI（ref）
                                          ▼
CLI 读回 artifact ──> 校验 mime/大小/base64 ──> 写会话保留期二进制 artifact ──> 返回本地路径
```

- 幂等/代际：`admit` 以 `(workspaceKey, taskId, inputId)` 为键覆盖写，`generation` 单调递增；
  `read` 前后各取一次快照，generation 或授权字段变化即失败（不用超时掩盖）。
- 过期：归档条目 `admittedAt` 早于 `TOPIC_RESOURCE_ARCHIVE_TTL_MS`（7 天）或超出条目上限时淘汰；
  缩容与淘汰只发生在 `admit`（单一写路径）。
- 取消：CLI 侧 abort → 反向 `topic/resource/cancel`（best-effort），Host 侧 AbortController 中止
  provider 下载；断连/超时（120s）一律拒绝，不返回半文件。
- 未知 ACK：archive 写入失败/回执丢失时**不发布**资源索引附件，也不发送带 `inputId` 的 prompt；
  普通对话继续（模型因此拿不到选择器，工具无从读取），只记 warn，不把失败重试成"已接纳"。

## 否定场景（必须拒绝）

- 未接纳 input（archive 无记录 / admission 非 accepted / 任务或 workspace 不匹配）。
- 跨 session：`taskId` 与 archive 归属不一致；inputId 属于别的任务。
- 越界序号：`index` 未在快照该消息资源索引内。
- 模型提交 `url`、`path`、`sessionId`、`chatId` 等字段（strict schema 拒绝）。
- 资源大小超过 `PROTOCOL_V4_LIMITS.attachmentMaxBytes`；base64 与声明字节不一致。
- bot 被停用、provider 非 feishu/lark、凭据/群/授权换代、下载重定向到非飞书域。
- 取消（abort）后不得返回 ref 或路径。

## 边界与不搬项

- 不搬 `reply`（`ReplyToChannel`）、不搬群聊 topic history 增量/卡片、不搬手机 relay 私有频道。
- 本仓没有群 thread 模型：快照以 `(botId, chatId, providerMessageId)` 标识消息，不虚构 threadId。
- 资源索引以 `text/plain` prompt 附件下发（`topicResources.txt`），替代上游的 topic history 附件；
  只列本次任务已接纳的 A 序号，不展开正文。
- 最小完整片只支持现有 Feishu/Lark 适配；`astrbot` 等 provider 明确报 "Topic resource provider
  unavailable"。

## 远程 attachment 方法面（默认拒绝）

`IBotsService.validateTopicResource/readTopicResource` 是 Host 反向 RPC 的字节下载入口，
`handleInboundMessage/handleProviderCallback*/watchAutomationRun` 是只允许受信 provider 回调、
astrbot 桥接与 cron 终态钩子调用的入站面。`web-remote-replayable`（手机与浏览器 Web）过去
无条件发布整个 Bots 频道，会让任意配对客户端用 `taskId/workspacePath` + 索引直接下载 bot 资源，
或伪造 bot 入站/回调，绕过 CLI 任务归属、工具权限和 callback 鉴权。

- `packages/services/src/bots/bots.ts` 公开纯方法面 `WEB_REMOTE_BOTS_ALLOWED_METHODS`，只含既有
  Bot 管理与读取 UI 方法；Desktop attachment 与 `server-core` HTTP `/ws` 共用该契约，未来新方法默认拒绝。
- `desktop-continuous`（`/ws/host`）不套方法白名单，保持完整服务面；Host 内部 topic callback、HTTP webhook 路由
  使用 `ServiceCollection` 中的原始服务实例，不经过远程 attachment facade。
- `web-remote-replayable` 的远程 facade 拒绝 resource read/validate、入站回调、provider callback、automation watch
  等 Host-only 方法，拒绝错误为 `kind: "feature_disabled"`。未经 accepted 的读取仍由 Host archive authorization 拒绝。

## 授权指纹与代际复验

- `topicResourceAuthorizationId` 绑定 `bot.id/provider/credentialRef/feishuAppId/providerUserId/chatId`。
  修复原因：`credentialRef` 是按 `bot.id` 派生的稳定 key，原地更换 appId/凭据不会改变它；
  只绑 `credentialRef` 时旧快照会在重新绑定后的 bot 上继续被视为已授权。
- 下载前后各复核一次：`inputId`、`generation`、`authorizationId` 任一变化都拒绝；
  `inputId` 缺省时 Host 解析到最新已接纳输入，若期间同一任务又接纳了新输入（generation 可能
  同为 1），也必须按快照换代失败，不能仅比较序号。

## 验收场景

1. loopback ingress → `admit` → reverse `topic/resource/read` → provider 下载（本地 HTTP 服务）→
   CLI ref 回传，字节与原文件 sha256 一致。
2. 未接纳 input / 跨任务 inputId / 越界 index / 未知 provider → 拒绝，且 archive 不新增条目。
3. 下载期间 bot 停用（generation 变化）→ 拒绝并不返回 ref。
4. abort → Host 侧取消，provider 请求中止，不返回 ref。
5. CLI 工具契约：strict schema 拒绝 URL/路径/会话字段；无 port 不注册；artifact 大小/编码不符拒绝。
6. 下载期间同一任务接纳新输入 → 即使 `generation` 同为 1，也按快照换代拒绝。
7. `credentialRef` 不变但 `feishuAppId`/`providerUserId` 换代 → 授权复核失败。
8. Mobile/Web-client attachment 与 `packages/zcode-server-cli` 的 HTTP `/ws` 均直接调用
   `readTopicResource`/`validateTopicResource`/`handleProviderCallback*`/`handleInboundMessage`/
   `watchAutomationRun` → `feature_disabled`；通过真实 WebSocket loopback 验证 bogus RPC 与未来方法默认拒绝，
   同时正向验证已有 Bot 管理方法仍可用。`/ws/host` desktop-continuous 与 Host 内部可信 topic callback
   仍可用；未经 accepted 的读取由 Host 授权逻辑拒绝。

## 验证入口

- `node --import tsx --test --test-isolation=none apps/zcode-cli/packages/core/test/read-topic-resource-tool.test.ts`
- `node --import tsx --test --test-isolation=none apps/zcode-cli/packages/bootstrap/test/topic-resource-port.test.ts`
- `node --import tsx --test packages/services/test/topicResourceLoopback.test.ts`（隔离 HOME/XDG/loopback）

## 已知边界（本切片不声称完成）

- 远程 workspace（SSH/WSL/Docker source server）：CLI 连的是远端 Host，远端 bots 配置为空，
  读取会显式报 `Topic resource authorization unavailable`；桌面 bot 归档尚未经 relay 转发。
- 仅 `feishu`/`lark` 有 `downloadTopicResource`；其他 provider 在接纳阶段即拒绝归档。
- 资源索引是纯文本 prompt 附件（`topicResources.txt`），不是上游的完整 topic history 附件。
- 未搬 `ReplyToChannel`、群卡片、手机 relay 私有频道与线程（threadId）语义。
