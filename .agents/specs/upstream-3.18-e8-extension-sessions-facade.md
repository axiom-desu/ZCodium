# E8 扩展 SDK 最小闭环：上游 sessions facade

上游固定源 `zai-org/ZCode@fec97590`（3.18.2）的 `packages/shared/src/extension-host/capabilities.ts` 与
`packages/services/src/extensions/sessionsBackend.ts`。本片只搬「会话 facade 的十二个 App 意图」，
不搬 `views`/多槽位/context pump/interactions/rows/audit 等其余上游面。
`MBearo/ZCode-rs` 仅参考，不作为产品上游。

## 范围与产品规则

- 新增 12 个能力：四个读 `sessions.listProjects|listSessions|readSession|waitSessions`，八个写
  `sessions.createSession|forkSession|sendToSession|interruptSession|renameSession|openSession|setSessionArchived|setSessionPinned`。
- 能力表仍然是能力的唯一定义；SDK `ctx.sessions` 只由能力表推导，不新增第二套 DTO。
- 新能力入参/返回**直接引用** `@zcode/session-control/contracts` 的 canonical App schema（与模型会话
  控制工具同一份定义）；本仓不复制、不改写这些 schema。
- 新增两个档位：`sessions.read`、`sessions.write`，`sessions.write` 包含 `sessions.read`
  （`grantsCover`/`normalizeGrants` 是唯一判定）。四项读要 `sessions.read`，八项写要 `sessions.write`。
- 清单必须声明能力所需档位（`undeclared-grant`），默认拒绝：未声明 → `not-declared`；未授予 →
  `not-granted`；协议版本不符 → `incompatible`。批准前不加载插件代码、不启动进程。
- 授权记录不隐式扩张：当前声明未被已记录档位覆盖（例如 read 变 write）时回到 `needs-consent`；
  只有 `decideGrant` 收到与当前规范化声明完全一致的请求才写入记录。
- 协议名 `sessions` 版本 1，显式协商：清单 `protocols.sessions` 不是 1 时十二项能力都报
  `incompatible`；未声明视为当前版本。现有 `projects` 协议与三项 v1 能力语义不变。

## 所有者与事件顺序

```text
插件进程 ctx.sessions.<intent>
  → loopback HTTP（Bearer token）→ CapabilityGateway（唯一准入点）
      认证 token→pluginId → body pluginId → generation → workspaceIdentity
      → 同意/授权 → 声明 → 协议 → 输入 schema
  → dispatch(pluginId, generation, input, signal)
      → AppControlService.bindClient({kind:"client", clientId:"extension:<plugin>",
                                      connectionId:"extension-host:<gen>:<plugin>", signal, assertCurrent})
      → control.<intent>(ctx, input)  ← 既有十二意图；不新建 session/task owner
  → 返回时网关复检（撤销/换代/工作区），迟到结果不写回
```

- 会话/任务/正文/导航的 owner 仍是既有 project/task/repo/runtime；扩展网关不读写 Repo、不直接操作
  runtime、不创建第二 accepted 队列。
- 身份只来自网关认证的 token 与请求代际；`assertCurrent` 由网关注入（撤销、换代、停止即失效）。
- 撤销/停止：网关 `cancelPlugin`/`cancelAll` 中止在途 signal；`waitSessions` 随之结束，调用方得到
  `canceled`；之后 token 已失效，旧调用不能写回。停止与撤销都不删除用户会话数据。
- 跨插件伪造不可能：A 的 token 只能得到 A 的 pluginId，body 声称 B 直接 `unauthorized`；
  网关只按认证身份取声明与授权。
- 每插件凭据绑定身份 + 代际：代际变化后旧凭据失效，`connectionId` 也随之变化。
- `waitSessions` 的取消链是「网关 signal → `bindClient.signal` → `waitForOperations`」。wait 必须
  保持可信上下文的**对象身份**（App control 用 WeakMap 绑定连接事实，`{...ctx}` 会丢绑定）；
  其 initial baseline 也必须来自 owner 的真实快照，不能用合成的 revision 0/unknown。
- 幂等身份是 `appControlCommandId(callerId, requestId)`，`callerId` 含插件身份：同名 requestId
  跨插件不共享命令；同插件重放才命中同一 receipts。

## 拒绝与错误

- 扩展错误码新增 `forbidden` / `unavailable` / `conflict`，由 session-control 的同名错误映射；
  其它后端错误保持 `backend-error`（不泄漏路径/远端地址）。已有 `canceled` 语义不变。
- Host 没有装配 App 控制（非 Desktop Local Host、旧 Host）时十二项能力返回 `host-unavailable`，
  不伪装成功，也不降级为直接读库。
- 输入/输出在网关两侧各校验一次（能力表 schema + facade schema）；输出不符合 schema → `backend-error`。

## 不变量

- 唯一 Host/runtime/CommandInbox：扩展不新增 session owner，不自行 stop/revoke 会话。
- `workspaceIdentity?.trim() || workspacePath` 语义不变；扩展服务仍按窗口 workspace 身份隔离。
- 现有 v1 三项 SDK（`settings.get` / `projects.list` / `context.get`）的入参与返回含义不变。
- Node 插件不是 OS sandbox：授权只做归因/准入，循环回环 + 逐插件 token 不是操作系统隔离。
- 手机/Web 不暴露扩展服务；不新增远程/手机能力。

## 验收

- `pnpm --filter @zcode/session-control test`、`shared/extension-host` 契约测试（write 覆盖 read、
  协议协商、清单 undeclared-grant、capability 表与 canonical schema 的对象身份）。
- 网关负向：未声明/未授予/跨插件伪造/撤销中在途 wait 收到 `canceled`/迟到成功不投影/
  非 canonical 输入与输出（不能只用 unknown→cast 绕过 strict schema）。
- 真实 loopback + 真实 `createAppControlService` facade：子进程插件读会话、受控改名（mutation），
  撤销后再调用 401；未装配 App 控制时 `host-unavailable`。
- 真实临时 SQLite 项目仓储 + SDK：list/read 来自仓库、rename 可在仓库读回、wait 在 running 上挂起、
  revoke/stop 取消在途 wait、撤销后迟到 ACK 不否认已执行、同 session 的相同 requestId 跨插件不共享
  幂等命令。
- 真实 Desktop Main 子进程（supervisor + worker + 插件 SDK）纵向：list/read/rename 经真实 App control，
  撤销后子进程停止且旧 token 401。
- 同版本把 read 改成 write（或新增档位）回到 `needs-consent`，不沿用旧记录。
- 真实 UI consent：`ExtensionStatusSlotView` 显示档位含义，启用提交当前声明档位；项目读、会话读/写与非 OS sandbox 提示使用仓库五种原生 locale（en-US、zh-CN、ja-JP、ko-KR、ru-RU），不得让新增会话档位回退为英文。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 零新增。

## 本片未做 / 后续

- 上游完整视图/多槽位/context pump/interactions/rows/列表订阅、`sessions.fullAccess`、
  `sessions.request` 授权弹窗请求、写审计行与 `inputSource:{kind:"extension"}`（需要 v4 协议新增来源类）。
- `createSession` 的「省略 project 用插件项目」：本仓没有插件项目 owner，保持 canonical 输入必填 project。
- Desktop 集成纵向的 task/agent 端口仍是测试替身（真实 `zcodeTaskService`/`zcodeAgentService` 需要
  运行中的 Agent）；仓库事实由 services 层的临时 SQLite 纵向覆盖。
- 不宣称已兼容完整上游 SDK。
