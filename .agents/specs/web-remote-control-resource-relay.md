# 手机远控资源中继判定：上游 3.15.1 topic resource relay 与 relay 地址解析

判定记录（**不引入实现**）。回答「上游 3.15.1 的 topic resource relay 协议面」与
「`zcodeEndpoint.ts` 的 relay 地址解析」对我们 fork 是否适用。结论：**两项都不适用，不搬运、不改生产代码。**

- 上游版本：`aac47556 feat: update to v3.15.1`（2026-10-10T10:57:01Z）
- 本仓库基线：`main`（撰写时 `9af24180`）
- 上游相关产物：
  - `packages/services/src/zcode-agent/topicResourceRelay.ts`、`topicResourceRelayClient.ts`、
    `topicResourceRelayChannel.ts`、`topicResourcePeers.ts`、`topicResourceBridge.ts`
  - `packages/shared/src/zcode-protocol/index.ts` 的 `TOPIC_RESOURCE_RELAY_*` 与 4 个 schema、
    `topic/resource/read`、`topic/resource/cancel`
  - `packages/shared/src/zcodeEndpoint.ts` 的 `DEFAULT_WEB_REMOTE_CONTROL_RELAY_WS_URL` +
    `resolveWebRemoteControlRelayWsUrl`
- 相关 spec：[`web-remote-control-acked-relay.md`](./web-remote-control-acked-relay.md)（其
  「剩余·topic resource relay」一行以本 spec 的判定为准）、[`web-remote-control.md`](./web-remote-control.md)、
  [`upstream-sync-3.15.1.md`](./upstream-sync-3.15.1.md)

## 结论

| 上游项                                            | 判定       | 一句话依据                                                                                                                                     |
| ------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| topic resource relay（分块资源反向中继）          | **不适用** | 我们全仓没有它的生产者/消费者（协议方法、schema、service、bots 回读、CLI 入口全 0 命中）；它是 v4 协议面 CLI↔Host 的反向频道，不是手机远控链路 |
| `zcodeEndpoint.ts` 的 relay 地址解析（含 bugfix） | **不适用** | 我们 `zcodeEndpoint.ts` 里 `relay` 0 命中，`ZCodeEndpointUrls` 没有 `relayWsUrl`；relay 地址只来自用户自配置或同源页面推导                     |

因此本次 **没有改任何生产代码**（`packages/shared/src/zcodeEndpoint.ts` 未动），也没有新增测试。

## 一、上游 topic resource relay 是什么

**它解决的问题**：desktop-attached remote workspace（远端 Host）里的 CLI agent 需要读取一条
历史消息中的「主题资源」（bot 会话附件，例如飞书消息里的图片/文件）。资源字节只有桌面 main 上的
`IBotsService`（持有 bot 凭据）能取到，远端 agent 取不到；而现有 stdio / WebSocket 连接有 RPC 帧
大小上限，不能把整个 base64 附件塞进一帧。

**它的做法**：在已鉴权的远程连接上开一条私有反向频道（`TOPIC_RESOURCE_RELAY_CHANNEL =
"host-topic-resource"`），远端 agent 按 `validate` → `begin`（返回 metadata）→ 逐块 `chunk`
（`TOPIC_RESOURCE_RELAY_CHUNK_BYTES = 384 * 1024`）→ `finish` 拉取，客户端拼块校验 sha256；
`cancel` 与超时回收传输。桌面侧 `createTopicResourceRelay` 只缓存有界附件（最多 2 条在途、120s TTL），
由 `createWindowTopicResourceRelay` 按当前窗口/连接路由到 bots service；`reply` 复用同一频道做 bot 回复。

**上游消费链**（每条都能用 `git grep`/`git show` 复核）：

| 层         | 上游位置                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| 协议契约   | `packages/shared/src/zcode-protocol/index.ts:360-361`（channel/块大小）、`4180/4182`（方法名）                       |
| 中继实现   | `packages/services/src/zcode-agent/topicResourceRelay{,Client,Channel}.ts`、`topicResourcePeers.ts`                  |
| 服务装配   | `packages/services/src/node.ts` 的 `channelReplyExecutor` / `topicResourceExecutor` / `topicResourceValidator`       |
| 服务端注册 | `packages/server/src/{http,entry-stdio,remote/connect}.ts` 反向 `ChannelServer.registerChannel`                      |
| 桌面注册   | `packages/desktop/src/host/windowTopicResourceRelay.ts`、`packages/desktop/src/host/serverRemoteConnection.ts`       |
| bots 能力  | `packages/services/src/bots/bots.ts:130/133/136`（`replyToChannel` / `validateTopicResource` / `readTopicResource`） |
| agent 入口 | `packages/services/src/zcode-agent/zcodeAgentService.ts` 的 `topic/resource/read` 分支                               |
| CLI 入口   | `apps/zcode-cli/packages/core/src/session-context/topic-resource.ts` + `ReadSessionContext` 的 `attachment` 分支     |

## 二、为什么我们不需要（证据）

所有命令在仓库根目录执行，排除 `node_modules`、`dist` 与 `.agents` 文档（只算源码）。

| 复核项                             | 命令                                                                                                                                             | 结果                                                                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全仓无 topicResource 生产者/消费者 | `git grep -li 'topicresource' -- . ':!**/dist/**' ':!**/node_modules/**' ':!.agents/**'`                                                         | **0 命中**（exit 1）                                                                                                                                                                                                          |
| 无协议方法                         | `git grep -n 'topic/resource' -- . ':!**/dist/**' ':!.agents/**' ':!**/node_modules/**'`                                                         | **0 命中**（exit 1）                                                                                                                                                                                                          |
| `TOPIC_RESOURCE_RELAY` 源码 0 命中 | `git grep -n 'TOPIC_RESOURCE_RELAY' -- . ':!**/dist/**' ':!.agents/**' ':!**/node_modules/**'`                                                   | **0 命中**（exit 1）                                                                                                                                                                                                          |
| 无 bots 回读/回复能力              | `git grep -n 'channelReply\|replyToChannel\|readTopicResource\|validateTopicResource' -- . ':!**/dist/**' ':!.agents/**' ':!**/node_modules/**'` | **0 命中**（exit 1）                                                                                                                                                                                                          |
| 上游 6 个文件在我们树里不存在      | `git cat-file -e main:<path>`                                                                                                                    | `topicResourceRelay.ts`、`topicResourceRelayClient.ts`、`topicResourceRelayChannel.ts`、`topicResourcePeers.ts`、`desktop/src/host/windowTopicResourceRelay.ts`、`desktop/src/host/serverRemoteConnection.ts` 全部 **ABSENT** |

**agent 侧入口也不存在**：我们的 `ReadSessionContextInputSchema` 只有
`sessionId/query/strategy/maxTokens`，`strategy` 只有 `relevant | handoff`
（`apps/zcode-cli/packages/contracts/src/tools/read-session-context.ts:10-38`）。上游在同一文件
`:31-72` 新增 `strategy` 的 `topic` 值、`attachment` 字段，并用
`.refine((value) => !value.attachment || value.strategy === "topic")` 约束；我们的
`read-session-context.ts` handler 里没有 `if (parsed.attachment)` 分支。也就是说，**没有任何
调用方会向远端索取主题资源**。

**bots 侧只有入站能力**：我们能收下 bot 入站附件（`packages/services/src/bots/providers/types.ts:102`
的 `downloadAttachment`），但没有「回读某条历史消息的附件」的接口；上游的
`readTopicResourceMessage`（provider 层）与 `readTopicResource`（service 层）我们都没有。

**不是「换条路径」，是整条能力不存在**：上游 topic resource relay 依赖的
`server` 类 RemoteTarget（`packages/shared/src/remoteTarget.ts:29`）与 `serverRemoteConnection.ts`
我们树里也没有（我们 `RemoteTarget = ssh | wsl | docker`，`remoteTarget.ts:4/16/22`）。即便只保留
SSH/WSL/Docker 远端路径，缺的仍是 bots 回读接口 + 协议入口 + CLI 附件入口这三段，没有可搬运的落点。

### 与手机远控链路的关系：不是同一条链路

上游 topic resource relay 属于 **v4 协议面**（CLI agent ↔ Host 的反向频道），服务的是远端 Host
读取桌面侧 bot 资源；**不是**手机远控（`web-remote-control`）的 wire。手机远控的大消息需求已在
第二轮由我们自己的实现解决：

- `packages/shared/src/webRemoteControl/rpcTransport.ts`：`encodeWebRemoteControlRpcFrames`
  （`:253`，单帧快路径 + 二分分片 + fail-closed CRC32）、`WebRemoteControlRpcAssembler`（`:380`，
  单槽装配/幂等/超时）、`WebRemoteControlRpcReplayBuffer`（`:635`，go-back-N 重传）、
  `WebRemoteControlRpcAckScheduler`（`:763`，ack 合并/deadline）。
- 桌面 `attachWorkspaceHostPort`（`packages/desktop/src/main/webRemoteControl/hostBridge.ts:56`）
  把 Host attachment 的 MessagePort 协议整体走 `rpc-frame`；手机侧同构
  （`packages/web/src/mobile/protocol.ts`）。任何超过物理帧上限的消息都会自动分片、带 CRC 与 ack。

所以「手机端拉取大资源」的通用原语已经就绪；缺的只是 Host 侧要暴露的「读 workspace 资源」方法，
不是一套 topic resource 协议。

## 三、`zcodeEndpoint.ts` relay 地址解析（证据）

上游在该文件里加了：

- `DEFAULT_WEB_REMOTE_CONTROL_RELAY_WS_URL = "wss://zcode.z.ai/ws"`（`aac47556` 文件 `:14`）
- `resolveWebRemoteControlRelayWsUrl`（`:235-251`）与 bugfix 注释（`:244`）：
  「标准 test endpoint 已部署独立 relay；继续固定到生产 relay 会让测试环境跨环境配对」
- 测试：`packages/shared/test/zcodeEndpoint.test.ts:152`
  「uses the test relay only for the standard test endpoint」

我们这边：

| 复核项                                     | 命令                                                                  | 结果                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `zcodeEndpoint.ts` 没有 relay 概念         | `git grep -n -i 'relay' -- packages/shared/src/zcodeEndpoint.ts`      | **0 命中**（exit 1）                                                  |
| `ZCodeEndpointUrls` 没有 `relayWsUrl`      | `packages/shared/src/zcodeEndpoint.ts:34-42`                          | 只有 `origin/apiBaseUrl/webShareCallbackUrl/zcodePlan*`               |
| `resolveWebRemoteControlRelayWsUrl` 不存在 | `git grep -n 'resolveWebRemoteControlRelayWsUrl' -- . ':!**/dist/**'` | 仅出现在 `.agents/specs/web-remote-control.md` 描述的**上游**恢复结果 |
| 上游 `TEST_ZCODE_ENDPOINT_ORIGIN` 我们已删 | `git grep -n 'TEST_ZCODE_ENDPOINT_ORIGIN' -- packages/shared/src`     | **0 命中**                                                            |

我们的 relay 地址来源全部是显式配置或同源推导，**没有内置 production/test relay 常量**：

- **custom（自托管 relay）**：地址取 `settings.webRemoteControlCustomEndpointUrl`，先校验必须是
  `ws:`/`wss:`（`packages/desktop/src/main/webRemoteControl/manager.ts:226-228`），未配置或非法直接
  `throw`（不回退 LAN）；再传给 `createRelayDeviceTransport`（同文件 `:291-293`，`relayTransport.ts:38/118`）。
- **LAN（默认）**：地址来自 `LanRemoteControlEndpoint.start()` 实际绑定成功的地址集合
  （`packages/desktop/src/main/webRemoteControl/lanEndpoint.ts:146-150`），不指向任何公网域名。
- **手机端**：从页面 `window.location` 同源推导
  （`packages/web/src/mobile/protocol.ts:497-504`、`packages/web/src/main.tsx:233-242`）。

由于我们根本没有「endpoint origin → 固定 relay」的解析函数，上游那个「test endpoint 被固定到
production relay」的 bug **在我们代码里没有落点**，无需修复。这也与本仓库不跟官方服务端点/OAuth
常量的取舍一致，并符合 `web-remote-control.md` 决策 #2「不直连官方 relay、不默认、不回退」。

> 附带发现（不属于本次改动范围，仅记录）：`packages/web/src/env.d.ts:13` 仍声明
> `VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL?: string`，但全仓没有消费者
> （`git grep` 仅命中声明处）。它是一个可清理的死声明；因不在本次允许改动的文件内，未处理。

## 四、以后若要支持手机端拉取 workspace 资源，从哪里入手

**不要搬 topic resource relay 到手机链路**（它的 owner、频道与消费方都是 v4 协议面）。正确顺序：

1. **定所有者**：资源字节在谁手里（远端 Host / 桌面 main / 本机磁盘 / bot 凭据）。按
   `AGENTS.md` 口径只保留一个所有者，用 owner/lease 与既有 attachment 路由，不新建第二条状态链路。
2. **加读取接口**：在 Host attachment 的 RPC / v4 协议面上暴露「读资源」方法，返回内容或引用；
   若是桌面独有的资源（如仅有本地缓存/凭据），先走既有的 `platform-request` / bridge 路由。
3. **大消息承载**：直接复用已就绪的
   `packages/shared/src/webRemoteControl/rpcTransport.ts` 分片 + CRC32 + ack + 重传，
   不要在业务层再写一套分块。
4. **区分两种链路语义**：`desktop-continuous` 与 `web-remote-replayable` 的 stream/snapshot/queue/重连
   必须分别验证（`AGENTS.md` 硬约束）。

排查起点：`packages/desktop/src/main/webRemoteControl/{payloadRouter,bridgeController,hostBridge}.ts`、
`packages/web/src/mobile/protocol.ts`、
`packages/shared/src/webRemoteControl/{envelope,rpcTransport}.ts`。

## 五、复核命令汇总

```bash
# 1. topic resource 源码 0 命中（排除 .agents 判定文档与 dist/node_modules）
git grep -li 'topicresource' -- . ':!**/dist/**' ':!**/node_modules/**' ':!.agents/**'  # exit 1
git grep -n 'topic/resource' -- . ':!**/dist/**' ':!.agents/**' ':!**/node_modules/**'   # exit 1
git grep -n 'TOPIC_RESOURCE_RELAY' -- . ':!**/dist/**' ':!.agents/**' ':!**/node_modules/**'  # exit 1
# 2. 上游 6 个文件我们不存在的确认
for f in packages/services/src/zcode-agent/topicResourceRelay.ts \
  packages/services/src/zcode-agent/topicResourceRelayClient.ts \
  packages/services/src/zcode-agent/topicResourceRelayChannel.ts \
  packages/services/src/zcode-agent/topicResourcePeers.ts \
  packages/desktop/src/host/windowTopicResourceRelay.ts \
  packages/desktop/src/host/serverRemoteConnection.ts; do
  git cat-file -e main:$f 2>/dev/null && echo "EXISTS $f" || echo "ABSENT $f"
done
# 3. zcodeEndpoint 无 relay
git grep -n -i 'relay' -- packages/shared/src/zcodeEndpoint.ts            # exit 1
# 4. 上游原物
git show aac47556:packages/services/src/zcode-agent/topicResourceRelay.ts
git show aac47556:packages/shared/src/zcodeEndpoint.ts | sed -n '235,251p'
git show aac47556:packages/shared/test/zcodeEndpoint.test.ts | sed -n '152,169p'
```

## 不做什么

- 不引入 `TOPIC_RESOURCE_RELAY_*`、4 个 relay schema、`topic/resource/read|cancel` 与 5 个
  service 文件——无生产者/消费者，引入即死代码。
- 不引入 `DEFAULT_WEB_REMOTE_CONTROL_RELAY_WS_URL` / `resolveWebRemoteControlRelayWsUrl` /
  官方 relay 常量——与 `web-remote-control.md` 决策 #2（不直连/不默认官方 relay）冲突，且我们没有这条地址解析。
- 不改 `packages/shared/src/zcodeEndpoint.ts`（无该问题，保持我们的布局与命名）。
- 不在本次修改 `web-remote-control-acked-relay.md`（不在允许范围）；其「剩余·topic resource relay」
  一行由本 spec 取代。
