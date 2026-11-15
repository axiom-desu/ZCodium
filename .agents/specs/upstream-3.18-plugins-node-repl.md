# 上游 3.18 内置插件 / node_repl / 打包提案（P1）

父 spec：`.agents/specs/upstream-3.18-sync.md`（官方 `3c5b2276..fec97590`，3.18.2）。
盘点：`/tmp/sync318-platform-inventory.md` §2、§4、§5。
上游设计文档：`apps/zcode-cli/docs/design/v2/tool/20-node-repl-call-ledger.md`（本 spec §2 为其落地口径）。

## 1. 范围与取舍

| 项                                                         | 上游 3.18                                               | 本仓决定                                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| node_repl 调用账本                                         | `node-repl-host/src/call-ledger/**`                     | **移植**（§2）                                                                                                               |
| 无进展守卫                                                 | `node-repl-host/src/no-progress-guard.ts` + server 接线 | **移植**（§3）                                                                                                               |
| 浏览器代理 broker                                          | `call-ledger/browser-broker-proxy.ts` + server 接线     | **移植**（§2.3）                                                                                                             |
| CUA broker 每调用 token / facts                            | `cua-broker.ts`、`cua-bridge.ts`、`result.ts`           | **移植**（§2.2、§2.4），保留本仓 cua-driver 运行时装配                                                                       |
| ext host / plugin-api 包                                   | `packages/plugin-api`、`shared/src/extension-host/**`   | **不做**（需 `@zcode-dev` npm scope 与第二 utilityProcess）                                                                  |
| agent 插件发现 / 会话控制 / 话题资源                       | 3.18 新增工具面                                         | **不做**（C5 域，本 spec 不建文件）                                                                                          |
| 内置 design 插件（纯内容）                                 | `apps/zcode-cli/packages/design-plugin/**`              | **移植**（§4）                                                                                                               |
| 内置 zcode-site 插件                                       | `packages/zcode-site-plugin/**`                         | **不做**：需 `zcode_official` 账号 JWT + 远端 Sites 服务，本仓已删该链路；上游自身版本不一致（plugin.json 0.5.1、SEA 0.5.0） |
| 随包 npm/npx（`bundled-npm-assets.mjs`）                   | 3.18 新增，配合 Electron 44                             | **不做**：本仓无 bundled npm staging，引入即等于升级 Electron 并新增下载资产（§5）                                           |
| Electron 41→44 / builder 26.8→26.17 / updater 6.8.3→6.8.10 | 3.18 根 `package.json`                                  | **只出提案**（§5 + `/tmp/sync318-P1-packaging-proposal.md`），不升级                                                         |
| 身份头 / 遥测 / off-peak / 高速执行                        | 3.18 保留或新增                                         | **不恢复**：`highspeed` 执行仍是产品上排除项，不归一化成 `off-peak`；Google 公开 provider 保留                               |

## 2. node_repl 调用账本（唯一可信事实源）

```text
tools/call ─▶ ledger.open(requestMeta) ─▶ token（workerData 交 Worker）
CUA broker   ◀─ { id, token, method, input } ─┐
浏览器代理    ◀─ { id, token, op, … } ─────────┤ token → 账本条目（会话信息取自条目 requestMeta）
                                              └▶ facts：cuaApps / browserScreenshots / browserUse / computerUse
Worker 结果消息（可被 cell 冒充）─▶ toMcpRunResult(run, facts)：可信 key 只取 facts
tools/call 结束 ─▶ entry.close()：该 token 之后一律拒绝（超时/取消后的迟到请求不再写回）
```

### 2.1 账本 owner 与不变量

- 唯一 owner：`node-repl-host` 主线程的 `createNodeReplCallLedger()`。Worker（cell 与 bridge）不可写。
- 每次 `js` 调用一个 token（32 字节随机 hex），同时替代原来**整进程共用**的 CUA broker token 与
  浏览器 bridge 从环境变量读到的上游 token。
- 条目在 `tools/call` 的 `finally` 关闭；`resolve()` 只认未关闭的 token，未知/已关闭/非字符串一律
  `undefined`，调用方按原有文案拒绝（`… is not authorized`）。
- 账本 facts 是本次调用可信事实的唯一来源：`zcode/nodeReplCuaApp`、
  `zcode/browserScreenshotContentIndices`、`zcode/nodeReplBrowserUse`、`zcode/nodeReplComputerUse`
  只按 facts 写回；`run.cuaApp` / `run.browserScreenshotImageIndices` 一律忽略。
- 已知缺口与上游一致：cell 可经 `node:inspector#connectToMainThread()` 影响主线程；账本只防「冒充
  Worker 结果消息」。不因此禁用 inspector 模块（会破坏性能分析类库）。

### 2.2 CUA broker

- Worker 只发 `{ id, token, method, input }`；会话信息由 broker 按条目 `requestMeta` 构造（规则从
  Worker 侧 `requestContext` 原样移入 `cua-broker.ts`），缺字段报错文案不变。
- `runtime_scope === "subagent"` 时 broker 拒绝（`Computer Use is not available in subagent`），
  兜住绕过 bridge 的请求；Worker 侧同名检查保留。
- token 解析成功后立即记 `facts.computerUse = true`（在校验请求格式和 subagent 检查之前）：broker 拒绝、
  runtime 抛错、`isError` 都算一次真实尝试；未到达 broker 的尝试（只 bootstrap、Worker 侧 subagent 拒绝）不记。
- 目标应用身份在 broker 拿到 runtime 结果后从 `app-associations.primary` 读取并 push 进
  `facts.cuaApps`（一个 cell 内后者覆盖前者）。本仓 cua-driver 运行时装配保持不变。

### 2.3 浏览器代理 broker

- 主线程新增本机 socket（POSIX `.sock` / Windows 命名管道），把 Worker 请求转发到 ZCode 主进程的
  浏览器 broker。上游地址与 token 只在主线程读 `ZCODE_NODE_REPL_BROWSER_BROKER_SOCKET` / `_TOKEN`；
  起 Worker 时从环境里删除这两个变量（缩小暴露面，不是可信边界）。
- 转发前用条目 `requestMeta` 重写 `runtimeScope`/`sessionId`/`turnId`/`trace` 并换成上游 token，
  其余字段原样转发；上游 schema 校验与错误不变。
- `op` 为 `list`/`execute` 时在检查上游是否配置**之前**记 `facts.browserUse = true`。
- 上游未配置 → `Browser control is unavailable for this node_repl session`；请求 >1 MiB →
  `Node REPL browser broker request exceeded 1 MiB`；响应 >32 MiB → `Browser broker response exceeded the 32 MiB limit`；
  上游先断开 → `Browser broker closed before returning a response`（文案全部沿用原说法）。
- 取消：Worker 侧先断开则销毁上游连接（上游视为取消）；`close()` 关服务器并删除 socket 文件，
  `runtime.dispose()` 走同一条 `void proxy.close()`（迟到清理）。
- 读行线性开销：数据块先入数组，只在新块里找换行，命中后一次性 `Buffer.concat`；只对
  `execute` + `screenshot` 解析一次 JSON，转发的仍是原始字节。

### 2.4 结果组装

- `zcode/nodeReplCuaApp` = `facts.cuaApps.at(-1)`；`zcode/browserScreenshotContentIndices` 用
  `run.images` 与 `facts.browserScreenshots` 逐字节匹配（同一张截图只能认领一次）。
- 两个会话能力 key 只在 facts 为真时写 `true`；sandbox 通道（`setResponseMeta`、`emitStructuredResult`、
  内嵌 `_meta`）写入的同名 key 先删后写。
- `NODE_REPL_SERVER_VERSION` 升到 `0.7.0`：已装用户的插件缓存按 `(name, version)` 复用，不 bump
  就拿不到新 `server.js`。

## 3. 无进展守卫

- 按 (sessionId, turnId) 记账；turn 变化即清零，无 `turn_id` 的请求不计数（不可判定归属）。
- 提示：同码 ×5 起、×3 递增（5/15/45…）；同结果 ×10 起、×3 递增；调用量 30/80/200，之后每 200。
- 每次调用最多一条提示，优先级 `same_call` > `no_progress` > `call_volume`；提示追加为一条 text block，
  并写一行 stderr 诊断（不含代码内容）。
- 文案只授权结束本轮（`You may end this turn.`），不要求换做法；`js` 永不因无进展失败。
- 已有 core 重复调用提醒按完整 input 记签名（改一字符即重置），本守卫补「结果没变」这一维；不改 core。

## 4. 内置 design 插件（纯内容）

- 内容：`skills/design/**`（SKILL.md、7 份 references、6 个 `.mjs` 脚本、`design-resources/**` 资源与
  逐目录许可）+ `hooks/{hooks.json,run-hook.cmd,design-rules}`；无 MCP、无账号、无原生依赖。
- 目录名按本仓唯一识别名 `.zcodium-plugin/`（上游 `.zcode-plugin/`）；上游 `.claude-plugin/` 不随包
  （`BUILTIN_PLUGIN_TOP_LEVEL_PATHS` 不含它，staging 本就会丢弃）。
- 单一资产契约：seed 清单只登记一处（`BUILTIN_PLUGIN_SEED_PATHS["design-plugin"]`），
  `official-plugin-definitions.ts`、SEA 脚本都从它派生/镜像；`requiresRuntime:false`
  （不写 `RUNTIME_BUILD_SCRIPTS`）。
- 默认关闭（与上游一致）：首启不注入新技能；用户在插件页显式启用。
- 许可：`design-resources/LICENSE.md`(Apache-2.0)、`LICENSE-html-ppt`(MIT)、逐 skeleton `LICENSE`、
  `NOTICE.md`（含 "Modified by ZCode" 声明）随技能目录一起 staged；`third-party/copied-components.json`
  登记来源，不整份覆盖 `third-party/*`。
- hook 只注入一行技能指针，任何失败静默 `exit 0`；`onError:"allow"` 由现有 hook schema（`.passthrough()`）容忍。

## 5. 打包与依赖提案（不执行）

- 提案清单见 `/tmp/sync318-P1-packaging-proposal.md`：Electron `41.0.3 → 44.7.0`、
  `electron-builder ^26.8.1 → 26.17.0`、`electron-updater ^6.8.3 → 6.8.10`，含已知 API / node-pty /
  原生闭包变化。**本轮不升级**：不改根 `package.json`、`pnpm-lock.yaml`、Node/pnpm pin，不引入
  遥测/rum/opentelemetry/keyring 依赖。
- 版本号与 `(name, version)` 缓存一致：design `0.7.2`、node_repl host `0.7.0`、SEA 清单与
  `official-plugin-definitions.ts` 同步（上游自身 site 插件就吃过 0.5.0/0.5.1 不一致的亏）。

## 6. 事件顺序与失败语义

- `tools/call` 开始 → `ledger.open`（token 下发）→ 执行 → `toMcpRunResult(run, facts)` → `close()`。
  超时/取消后 Worker 迟到的 broker 请求拿不到条目，直接拒绝，不会改写已返回结果。
- 两个 broker 独立按 token 记账，互不依赖顺序；同一 token 的并发请求共享条目（facts 按到达顺序追加）。
- 账本条目关闭即失效，不做 GC 队列；进程退出由现有 shutdown trigger 收尾（proxy `close()` 删 socket）。

## 7. 验收（真实 runner）

- `pnpm --filter @zcode/node-repl-host test`（node:test）：
  `test/call-ledger/ledger.test.ts`、`test/call-ledger/browser-broker-proxy.test.ts`、
  `test/no-progress-guard.test.ts`、`test/result.test.ts`、`test/cua-bridge.test.ts`、
  `test/computer-use-onboarding.test.ts`。全部临时 socket/HOME，不连真实远端与用户数据。
- `node --test --test-isolation=none scripts/ci/builtin-plugin-assets.test.mjs`（design seed 存在性）。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。

## 8. 未实现 / 跨域缝（不在本 spec 落地）

- `packages/contracts/src/interfaces/mcp.port.ts` 两个会话能力 key 常量、`@zcode/core/repl` 的
  `matchBrowserScreenshotImageIndices` 公开纯函数、core `session-features` 对两个 key 的消费：属于
  契约/C5 域，本波不改；精确补丁见 `/tmp/sync318-P1-seams.md`。在 seam 落地前，写入侧 key 由
  `node-repl-host/src/result.ts` 持有同一字符串（读侧落地后改为从 contracts 导入）。
- 扩展进程（`extension-host`）、`@zcode/plugin-api`、agent 插件发现、会话控制、话题资源工具：不做，
  需单独切片（见盘点 §2.4、§7）。
- CUA `actionTitle`（工具卡 badge 文案）依赖 3.18 permission-broker 运行时上下文；本仓 cua-driver
  上下文无此字段，不移植。
- 随包 npm/npx、Electron 44 原生闭包：只在提案里。
- 随包内容不改写：`apps/zcode-cli/packages/design-plugin/skills/design` 加入 `.oxlintrc.json`
  的 `ignorePatterns`（与 vendored UI 子树同处置），因为逐字节上游内容会触发 `max-lines` /
  `no-unused-vars`，改写会破坏许可出处与哈希比对。
- 许可登记：`third-party/copied-components.json` 已登记 design 的 8 个来源与许可原文；`licenses notices`
  的二次生成等整合后统一执行（当前 `licenses check` 先报本波之前就存在的输入漂移）。
