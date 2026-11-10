# 3.17 同步 P1：RPC 兼容 / 二进制 / 订阅失败窄修

父 spec：`.agents/specs/upstream-3.17-sync.md`（首批切片 P1）。
权威来源：`git diff 3c5b2276 a9fe401e -- packages/rpc/src`（`channelClient.ts`、
`channelServer.ts`、`channels.shared.ts`、`serialization.ts`）。
本 spec 覆盖 RPC 框架与必要生产日志接线；不新增业务 owner，不改产品 ready / mobile wrappers。

## 目标行为

| 编号 | 行为                     | 规则                                                                                                                                                             |
| ---- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1   | `profileId` 错误字段透传 | 服务端 `PromiseError` 载荷与服务端白名单、客户端还原白名单都包含 `profileId`，与既有 `code/kind/status/retryAfterMs/data/detail/details/taskId/traceId` 同等对待 |
| R2   | 头部路由后才解码 body    | `ChannelClient.onBuffer` / `ChannelServer.onRawMessage` 先只解码消息头，命中本端类型后才解码 body；未知类型只解码头就返回                                        |
| R3   | Node `Buffer` 嵌套序列化 | 嵌套 `Uint8Array`（含 `Buffer` 子类）在 JSON fallback 里必须按 holder 上的原值判定，编码为 base64 标记，而不是 `toJSON` 后的 `{type:"Buffer",data:[...]}`        |
| R4   | 订阅失败帧               | 服务端 `listen()` 同步抛错时回 `EventError(205)` 帧；客户端收到后结束该订阅，不写入正常事件流                                                                    |
| R5   | 未知通道迟注册兼容       | `EventListen` / `Promise` 共用既有 pending 与原超时；注册前取消立即清理，超时分别回 `EventError` / `PromiseError` 并清理；迟到注册不复活                         |

## 消息与所有权

```text
client.listen(name)
  → EventListen(id,name,arg)        [client 持有 handlers[id] + activeRequests[emitter]]
  → server.onEventListen
      ├─ 通道存在且 listen 成功 → activeRequests[id] = disposable → EventFire(id,data)…
      ├─ 通道存在且 listen 同步抛错 → EventError(id,{name,message,stack?})，不登记 activeRequests
      └─ 通道未知 → pending[id] + 既有 timeout
          ├─ 注册 → 清 timer → listen 一次
          ├─ EventDispose / PromiseCancel → 清 timer + pending，不发失败帧
          └─ 超时 → 清 pending → EventError / PromiseError + 宿主 warn
  → client.onBuffer：头部=205 → handlers.delete(id) / activeRequests.delete(emitter) / emitter.dispose()
                                   + 通过注入 logger 记录一次诊断
```

- Desktop continuous 与手机 replayable 都使用这一帧级路由/失败语义；RPC 层不持有业务快照、队列或重放状态，
  attachment 的交付/恢复 owner 不变。本切片验证共享 RPC 协议，不冒充完整 Desktop/手机 E2E 验收。
- 订阅生命周期 owner 仍是 `ChannelClient`（客户端）与 `ChannelServer`（服务端）；本改动不引入第三个
  订阅表，也不改变 `EventDispose`/`PromiseCancel` 的既有释放路径。
- `EventError` 与 `EventFire` 使用同一帧形状（`[type,id] + body`），只是类型号不同，因此老客户端不会把
  失败当业务事件（旧实现会忽略未知类型号，等价于丢弃）。不做“偷用 EventFire 传错误对象”。
- 幂等边界：`EventError` 之后该 id 不再登记；迟到/重复的 `EventFire(id)` 因 emitter 已 dispose 被丢弃。
  未知通道订阅和 Promise 终结时移出 pending，后续 `registerChannel` 不会重复发起已终结请求。
  server dispose 清除 pending 计时器，避免终结后再回帧。

## 逐项根因与修法

1. **R1**：Host 的远程等待点（需要安装/升级、补凭据）用 `profileId` 指明实际操作线路；白名单丢弃后
   侧栏项目只能把不含凭据的目标交给向导。补进两侧白名单与载荷类型。
2. **R2**：本仓 `IPCClient` 在同一 protocol 上同时挂了 `ChannelClient` 与 `ChannelServer`，对端发来的请求
   会进 client 的 `onBuffer`，对端发来的响应会进 server 的 `onRawMessage`；旧实现无条件先解码 body，
   每条大载荷（数据同步归档等）被完整解码两次。改为按类型懒解码后，每个帧只由唯一接收方解码一次。
   本仓额外保留 `Initialize` 的 capabilities body 解码（本仓特性，上游无）：先判类型再解码 body。
3. **R3**：`JSON.stringify` 先调用 `toJSON` 再调用 replacer，`Buffer` 到这里已是
   `{type:"Buffer",data:[...]}`，`value instanceof Uint8Array` 不再成立：体积约 3.6 倍，每跳要解析上千万
   个数字，大插件还会超出远端单条消息上限，接收端也读不到 `byteLength`。修法是用 replacer 的 `this`
   （holder）取原值判断；不改协议形态，仍是 base64 标记。
4. **R4**：已结束的终端等资源会拒绝迟到订阅。旧实现里 `listen` 同步抛错会从 `onRawMessage` 一路逃逸到
   protocol 消息分发，可能带崩 Host，且客户端永远等不到该订阅的结论。改为独立失败帧 + 客户端终结订阅。
5. **R5**：同类问题在未知通道上表现为“静默悬挂”：`collectPendingRequest` 的超时只对 `Promise` 回帧，
   `EventListen` 既不回帧也不清理，客户端 `handlers`/`activeRequests` 与服务端 `pendingRequests` 永久泄漏。
   独立 review 后恢复既有迟注册兼容：`ipc.ts` 的 IPCClient 构造即创建非 defer ChannelServer 并发送
   Initialize，随后调用方才能 registerChannel；`examples/03-ipc-server-client.ts:84-91` 正是此顺序。
   IPCServer 也在创建双向 channel 后才安装预注册通道、发布 onDidAddConnection。同步拒绝会把此前
   合法的迟注册反向订阅终结。保留原有 1000ms（或调用方已有 timeoutDelay），不新增重试/超时，
   EventListen 超时回 EventError；取消、超时、server dispose 都删除 pending/timer，避免复活或泄漏。
   Desktop Host 的 deferInit/ready 与 mobile bridge ready 不作变更；本证据证明框架已有兼容时序，
   不声称当前所有产品入口都必现竞态。

## 日志

- 框架不使用裸 `console.error` 处理新增失败路径。`ChannelClient` 增加可选第二构造参数
  `{ logger?: RPCLogger }`；默认 `no-op`，需要诊断的调用方注入既有 logger（`packages/ui/src/logger.ts`、
  `createServiceLogger` 等）；不硬编码宿主日志实现，也不新增 console 输出。
- `ChannelServer` 追加可选第六参数 `{ logger?: RPCLogger }`，保留 timeout/deferInit/capabilities
  既有位置和语义；未知 Promise 超时也经此 logger 记录 `Unknown channel:`，不调用 `console.error`。
- 统一导出 `RPCOptions { logger?: RPCLogger }`，IPCServer / IPCClient / RemoteAgentConnection、client 的
  MessagePort / protocol / WebSocket 工厂追加可选 options 并贯穿到两端 channel；旧调用不破坏。
- 生产入口使用已有宿主日志：Desktop Host warn、renderer 的 UI logger.lifecycle.warn、Web/mobile 的 UI
  logger.lifecycle.warn（遵守 Web 无桌面 bridge 时生产不落盘策略），服务端既有日志出口。服务端也记录
  listen 同步失败，保证 mobile/web 客户端生产门控不会使服务端故障不可观察；stdio 不写 stdout。
- 失败诊断只含固定消息与路由名、requestId；不得记录 arg、响应 body、远端 Error 的 message/stack/name、
  URL、token、配对信息或上下文 ctx。原始 Error 仍仅在线上失败帧传递，不进入 logger。
- 日志不增加业务状态；不改 LoggingChannelServer/Client 或 mobile policy wrappers。

## 不变量 / 非目标

- 不改 `RequestType` 编号、不改既有 `ResponseType` 编号（只追加 205）、不改帧形状与 VQL 编码。
- 不新增业务通道、不新增缓存或第二份订阅真值；`Initialize` capabilities、`pendingRejections`、
  cancel 语义、`dispose()` fail-closed 行为全部保留。
- 不恢复本仓已移除的 `retryable` 字段（本仓白名单里本来没有，属于其他切片）。
- 不改 shared 错误、协议（wire 预算里的 204 常量是保守上界测量，非解码器）与 Rust 侧。
  唯一必要日志例外是 `diagnosticLogCatalog.ts` 的固定 `RPC event subscription failed: ` 前缀：
  否则安全宿主 sink 会把新消息整体压成 `[omitted]`，不能辨认失败类型。沿用前缀机制删除路由插值，
  不放行参数、原始错误或动态 channel；不扩大安全元数据白名单。
- 不改 lock / 公共父 spec；仅在 UI package.json 增加 logger 公开子入口，供生产接线复用既有出口，
  不改变 UI 日志策略或组件行为。必要生产接线包含 server HTTP/stdio、server-core HTTP、Host remote 与 bot port。

## 验收场景（回归测试）

测试文件：`packages/rpc/src/channelFailure.test.ts`、`packages/rpc/src/serialization.test.ts`。

1. `listen()` 同步抛错：Host 侧不抛（不崩）、客户端收到失败、正常事件流为空、两端订阅表都清零。
2. 失败帧之后迟到的 `EventFire`（同 id）被丢弃，不进入正常事件流。
3. 未知通道 `EventListen`：迟注册正常交付一次；超时回 EventError、两端清零且日志可观察，后续注册不重放。
   注册前取消无残留、无超时诊断；server dispose 不再发失败帧。
   同一场景的 `Promise` 仍超时回 `PromiseError`，随后 pending 清零；终结 server 后不再发超时帧。
   Promise 在超时前注册则仍正常执行一次并清除计时器；超时日志经注入的 RPCLogger 记录。
4. 双向 protocol：同一 protocol 上的请求帧只被 `ChannelServer` 解码一次、响应帧只被 `ChannelClient`
   解码一次（以 `JSON.parse` 计数验证 body 不重复解码）；未知类型不读取 body，Initialize 兼容仍通过。
   订阅初始化函数同步抛错（不仅 listen 方法本身）、非 Error 拒绝均转为 EventError。
5. `Buffer` 嵌套往返：编解码后仍是二进制（`Uint8Array`，字节一致），编码体积远小于数字数组形态；
   经真实 `ChannelClient.call` 往返同样保持字节。
6. `profileId` 从服务端错误透传到客户端 rejection。

## 验收命令

```bash
# 在临时 HOME / XDG_CONFIG_HOME / XDG_CACHE_HOME / ZCODE_DATA_BASE_DIR 下执行
pnpm vitest run packages/rpc/src packages/client/src packages/server/src/rpcDiagnostics.test.ts packages/web/src/mobile/protocol.test.ts packages/desktop/src/host/serverRemoteConnection.test.ts
pnpm typecheck
pnpm lint
pnpm --filter @zcode/rpc exec tsc -b            # 包内类型（root typecheck 亦覆盖 rpc）
pnpm exec oxfmt --check packages/rpc/src
pnpm exec oxlint packages/rpc/src
pnpm architecture:check --changed
```

## 独立 review 修复验收（先测试后实现）

- 真实 Channel/IPC 构造、client protocol / MessagePort / WebSocket 工厂注入 logger，模拟失败帧与未知
  通道超时，不只测 options 对象；RemoteAgentConnection 覆盖透传。
- 失败错误和 RPC arg 使用虚构敏感标记，断言 logger 输出不含标记；生产接线源文件回归确保 logger 未丢失。
- 新增/更新失败测试先实跑，后记录最终 targeted tests、类型检查、lint 的真实结果。
- 中断续作先复现现状：36 项测试通过，但 root typecheck 被 client 工厂测试调用不存在的
  `IFileService.onFileChange`、迟注册测试的非泛型 `Event<string>` mock 阻断。测试改用真实
  `IFileWatcherService.onDynamicChange`，并让 mock 显式满足 `IServerChannel.listen<T>`；不修改服务接口。
- 生产可观察性补充实际宿主路径回归：手机 replayable RPC 收到 EventError 后只调用 lifecycle warn，
  失败帧不进入任务流、重复/迟到帧不再交付；生产 Web 无 bridge 仍遵循既有 no-op 策略。
  stdio 入口经真实 ChannelServer 验证同步订阅失败与未知 channel 超时，安全 warn 只走 stderr，
  stdout 仅有协议字节。测试只用虚构敏感标记和临时 HOME，不读真实数据或日志。
- 本轮不改变未知 channel 的既有 1000ms 等待或 deferInit，不改 remote backend、shared 错误和 provider。
  入口 source guard 只补充检查接线存在，不替代真实工厂、Host/stdio 和 mobile 帧级测试。

## 前一轮交付与验证结果（独立 review 前）

- P1 框架实现完成；未修改父 spec、调用方或其他 agent 的文件，未 commit/push。
- 实现前回归测试实跑：14 失败 / 3 通过，确认订阅崩溃/泄漏、重复解码、Buffer 膨胀与 profileId 丢失。
  另修正恢复前测试本身未模拟对端 Initialize、泛型 stub 不满足接口的问题。
- 最终 `pnpm exec vitest run packages/rpc/src`：3 个文件、18 项测试通过（含原 capabilities 回归）。
- `pnpm --filter @zcode/rpc exec tsc -b` 与根目录 `pnpm typecheck`：通过。
  并行开发期间根类型检查曾遇其他切片尚未完成的 remote/attachment 错误；最终重跑已通过。
- `pnpm lint`：0 warnings / 0 errors；RPC 与本 spec 的 `oxfmt --check`、`git diff --check`：通过。
- `pnpm architecture:check --changed`：0 violations / 0 baseline / 0 new；rpc 当前为 unmanaged、无声明跨模块依赖，
  未新增运行时依赖或状态 owner。四个实现文件相对基线共 +90 / -30 行。
- 环境 Node `v24.19.0`、pnpm `10.33.2`；未在仓库 pin 的 Node `24.14.0` 上重跑，未修改版本约束。
- 以上是 RPC 帧级与 loopback 验收，不代表全量 3.17 对齐或完整 Desktop/手机 E2E 已交付。

## fetch failed 后续作验证

- 先检查未提交文件与本 spec；保留其他切片和并行 agent 的改动，未 commit/push。
- 修正测试类型：client 工厂改用真实 `fileWatcherService.onDynamicChange`；迟注册计数 mock 与
  泛型 `listen<T>` 适配分离（Vitest mock 包装会把泛型返回值宽化为 `unknown`）。
- 新增真实 Host direct/duplex、stdio 与 mobile 生产日志回归；修正测试夹具后先实跑，4 项失败
  均确认安全 sink 把新的 EventError 消息压成 `[omitted]`，其余 43 项通过。随后才补固定日志前缀，
  仍不保留动态路由、原始 Error、RPC arg、URL 或 token；不改 shared 错误、remote backend 和 provider。
- 最终目标测试：13 个文件、86 项通过，覆盖真实 IPC 工厂双端 EventError/未知 Promise、
  MessagePort/protocol/WebSocket 工厂、RemoteAgentConnection、Host loopback、stdio 与手机 replayable。
  原有迟注册/取消/超时语义不扩大；不宣称启动完整 Desktop 或浏览器 E2E。
- `pnpm --filter @zcode/rpc exec tsc -b`、`tsc -b packages/client packages/server packages/web` 通过。
  root `pnpm typecheck` 修复本任务 TS 错误后曾通过；最终重跑被并行资源解析改动阻断：
  `packages/desktop/src/host/index.ts:1651` 的 `resolveSourceServerReleaseRuntimeOptions()` 缺必要参数
  （TS2554）。未修改该业务段。
- 额外 `tsc -b packages/desktop/tsconfig.renderer.json` 未通过：bridge 的 `window.zcode` /
  `zcodePluginSandbox`、CSS side-effect module 与测试 Node 类型声明错误；不扩改 renderer 类型配置。
- 最终 root `pnpm lint`：0 warnings / 0 errors；目标 40 文件 `oxfmt --check` 与 `git diff --check` 通过。
  `pnpm architecture:check --changed`：0 violations / 0 baseline / 0 new；未新增业务 owner 或运行时依赖。
- 所有运行时测试均使用临时 HOME、XDG 目录和 `ZCODE_DATA_BASE_DIR`，只使用虚构输入与 loopback，
  未读取真实用户数据或日志。Node `24.19.0`、pnpm `10.33.2`；本机无 mise，未在 pin 的 `24.14.0` 上重跑。
