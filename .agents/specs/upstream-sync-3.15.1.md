# 上游 3.15.1 同步（Upstream Sync 3.15.1）

决策记录 + 工作清单。**本文只记录计划与依据，不引入实现。** 执行时按「工作项」逐条推进，每项独立可回滚。

- 上游仓库：`zai-org/ZCode`
- 目标版本：`aac47556 feat: update to v3.15.1`（2026-10-10T10:57:01Z）
- 基线版本：`29628c9 feat: update v3.14.3`（2026-09-23T09:36:31Z）
- 本仓库基线：`main`（撰写时 `7e4702b`；同步分支已变基到 `e3dce772`）

## 判定方法：上游是代码倾倒，只能看 scoped diff

上游的提交历史只有四个：

```text
77432b6  2026-09-20  Initial commit
872ad96  2026-09-20  feat: open source
29628c9  2026-09-23  feat: update v3.14.3
aac47556  2026-10-10  feat: update to v3.15.1
```

每个「版本」是一个 commit 把整棵树替换掉，提交信息只有版本号。所以**不存在"从提交信息判断影响"这条路**，只能对 diff 做目录限定：

```bash
git fetch upstream main
git diff --stat 29628c9 upstream/main -- <关注的路径>
```

每出一个上游版本跑一次同样形式的命令。这是本 spec 允许的唯一同步方式——不做 rebase、不做 merge。

## 上游这次发布的体量

|                                        |  3.14.3 |  3.15.1 |   变化 |
| -------------------------------------- | ------: | ------: | -----: |
| 文件总数                               |   7,060 |  16,880 | +9,820 |
| `docs/`                                |       0 |   2,235 |   全新 |
| `apps/zcode-cli`                       |   1,518 |   5,025 | +3,507 |
| `packages/ui/src`（`.ts`/`.tsx` 行数） | 327,422 | 387,269 |   +18% |
| `.agents`                              |     240 |     246 |     +6 |

总计 **11,736 文件、+1,942,918 / -25,090 行**。

结构性质：3.14.3 是**部分开源**（7,060 文件），3.15.1 接近完整产品（16,880 文件）。本仓库此前用 backfill 补齐的那批插件，正是上游这次开源出来的部分。

## 原则：跟上游的唯一正当理由是「白拿维护」

不是「保持同步」。按目的划线，而不是按新旧划线：

```text
改革线（本仓库自己的）  Rust CLI 重写、性能、未来的 native UI   → 不跟上游
白拿线（借力上游）      插件、协议契约、bug 与安全修复          → 跟上游
```

理由：上游 CLI 是 Node 实现（3.15.1 的 `apps/zcode-cli` 有 5,025 个文件），本仓库正在做 Rust 重写。**全量跟随等于放弃 fork 的立身之本。**

同时，「白拿线」也有上限——见工作项 4。

## 工作项 1：协议 delta（必做，优先级最高）

**为什么必做**：协议与服务端契约不一致会**静默**出问题——不是编译错，是运行时不兼容。

3.15.1 对协议面的改动：

| 文件                                          | 变化       |
| --------------------------------------------- | ---------- |
| `packages/shared/src/zcode-protocol/index.ts` | **691 行** |
| `packages/shared/src/zcode-protocol/trace.ts` | **11 行**  |
| `packages/shared/src/zcodeEndpoint.ts`        | **262 行** |

新增的协议面（非重命名，是实质新增）：

- **topic resource relay**：分块资源中继，`TOPIC_RESOURCE_RELAY_CHANNEL = "host-topic-resource"`，块大小 `TOPIC_RESOURCE_RELAY_CHUNK_BYTES = 384 * 1024`，配套 `read` / `cancel` / `relayChunk` / `relayMetadata` 四个 schema
- **MCP UI 实例生命周期**：`zcodeMcpUiOpenInstance` / `zcodeMcpUiCloseInstance`
- **MCP 资源读取**：`zcodeMcpReadResource` + `zcodeMcpResourceContentSchema`

```bash
git diff 29628c9 upstream/main -- \
  packages/shared/src/zcode-protocol/ \
  packages/shared/src/zcodeEndpoint.ts \
  packages/shared/src/model-provider-family.ts
```

**验收**：确认本仓库是否依赖被改动的协议面；依赖则跟，不依赖则记录「已核对」。

## 工作项 2：14 个插件换上游

判定依据：这些包在 3.14.3 里文件数为 **0**（`superpowers-plugin` 为 1），本仓库与上游都有 → 就是本仓库 backfill 的那批。

| 插件                             | 本仓库 | 上游 3.15.1 |
| -------------------------------- | -----: | ----------: |
| `android-emulator-plugin`        |     11 |          29 |
| `documents-plugin`               |     50 |          44 |
| `image-search-plugin`            |      4 |           5 |
| `ios-simulator-plugin`           |     10 |          23 |
| `pdf-plugin`                     |     54 |          43 |
| `plugin-creator-plugin`          |     10 |          13 |
| `presentations-plugin`           |      6 |           5 |
| `restore-legacy-sessions-plugin` |     13 |           7 |
| `skill-creator-plugin`           |      3 |           3 |
| `spreadsheets-plugin`            |     30 |          29 |
| `superpowers-plugin`             |     78 |          54 |
| `visualize-plugin`               |     26 |          26 |
| `zcode-cua-plugin`               |     10 |           9 |
| `zcode-guide-plugin`             |     13 |           9 |

**决策依据**：本仓库这批是 clean-room 重写，**没有测试覆盖**；上游那版是产品实际在跑的。保留 clean-room 版意味着永久双份维护——上游每改一次都要手工再实现一次。

**关于 clean-room 的法律理由已经消失**：`pdf-plugin-backfill.md` 记录走 clean-room 的原因是「原版 `LICENSE.txt` 为 Z.ai 非商业许可」。上游 3.15.1 现在以 **Apache-2.0** 发布同一批插件（`plugin.json` 的 `license` 字段与 `author: Z.ai`）。所以 clean-room 从「必须」变成「可选」，直接采用上游代码合法。

**前置判断（建议先做）**：挑一个插件（`pdf-plugin` 或 `documents-plugin`）对两边源码做 diff，判断是「结构等价、实现各自写」还是「连实现都一样」。前者说明两边会各自演化，后者说明留本仓库版本没有意义。只看一个插件即可定性。

**不要动 `zcode-cua-plugin` 的运行时**——见工作项 3。

### 例外：`superpowers-plugin` 不换，我们对的那份更新

`superpowers-plugin` 不是 clean-room 重写，而是 vendor 自 `obra/superpowers`
（`plugin-backfill-openbase-survey.md` 记录的基座）。上游 3.15.1 那份是**同一上游的另
一份（更旧的）快照**：14 个技能 / 54 文件，而我们这份是 15 技能 / 79 文件。文件级对应关
系表明我们更新（上游那份的 `code-quality-reviewer-prompt.md` + `spec-reviewer-prompt.md`
在我们这份里被 `task-reviewer-prompt.md` + `re-review-prompt.md` 取代，
`testing-anti-patterns.md` 被 `writing-good-tests.md` 取代），共同文件也普遍更长。

所以这一项的正确做法是**不动**：用上游那份覆盖是降级。要跟进上游，应直接取
`obra/superpowers` 当前版本再比对。上游那份的 `hooks/**` 本插件也不引用（清单无 `hooks`
键，运行时 hooks 服务只读用户 / 工作区配置），取过来是死资产。

详情与逐项对照见 `apps/zcode-cli/packages/superpowers-plugin/NOTICE.md`。

## 工作项 3：CUA 只取文本

### 本轮实际结果：这条早已执行过，照原样做会倒退

计划写的是「只取两份文本」。核查提交历史后，这件事**已经做过，而且被后续提交按实现改写过了**：

```text
5b728b64 2026-09-21  照搬上游插件（SKILL 297 行 / docs 464 行 / 单文件 1208 行 SDK）
21918a5b 2026-09-22  按实现改写文档层 → SKILL 432 / docs 437
35c39582 2026-09-24  对齐自带 driver       → SKILL 124 / docs 42
```

上游 3.15.1 那两份文本描述的是**闭源 Helper** 的能力：绑定即拉起、`selectText` / `performSecondaryAction` 可用、`paste` 支持 `md`/`html`、macOS 用 `cmd`、`HELPER_UNAVAILABLE` 路径。整篇取回等于撤销 35c39582 的对齐，并把模型引到本仓库不存在的实现上。

所以本轮改成**按缺口补**，并给宿主层补守卫（三个提交）：

| 提交       | 内容                                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `281596d1` | `docs/computer-use.md` 42 → 227 行，补成完整参考（含 `## Tool arguments` 等小节；它是 `agent.documentation.get("computer-use")` 的返回值）                                 |
| `399c74a0` | SKILL 124 → 178 行，补七项已实现却未文档化的面（`app.elements()`、`getState`/`requestAccess`/`stop`、文档入口、错误码表、一栅格规则、应用名逐字符复制、禁 osascript 守卫） |
| `25dcd165` | 宿主层测试 9 例（此前 node-repl-host **零测试**）                                                                                                                          |
| `779e7fac` | 插件版本 0.6.3 → 0.6.4（package / manifest / 官方 seed 定义三处一致）                                                                                                      |

判定依据来自上游自己的一条测试：`computer-use-onboarding.test.ts` 断言「按需取用的那份仍是完整参考」（必须含 `## Tool arguments`）。我们把它连同 `cua-bridge.test.ts` 一起移植过来——两者只依赖与上游逐字节相同的文件。

### 上游在 CUA 上做的是「接口开源、实现摘出去」

上游 `packages/zcode-cua/package.json` 原文：

```json
{
  "version": "0.6.3",
  "zcodeCuaPlaceholder": true,
  "description": "API-compatible placeholder package for Computer Use.
                  This build ships without Computer Use:
                  every runtime surface reports unavailable and fails closed."
}
```

README 补充：`Computer Use runtime, broker RPC, Helper install/launch/verify, PiP session client, native addon loader` 全部 `unavailable` + fail-closed。

真实驱动是**闭源签名 Helper**（`ZCode Computer Use.app`，bundle ID `dev.zcode.cua-helper`），只随官方安装包交付；`cua-helper-installation.md` 明说「产品代码不会尝试网络下载，也没有下载兜底」。上游仓库里 CUA 原生源码 grep 为空。

分层对照：

| 层                                            | 上游 3.15.1            | 本仓库                             |
| --------------------------------------------- | ---------------------- | ---------------------------------- |
| 插件 / 技能（agent 面向）                     | 开源                   | 有（backfill）                     |
| 契约（frame / host-display / request-access） | 开源                   | 有，且与上游**一致**（见下）       |
| broker / pip-session                          | **占位 + fail-closed** | **已删除**                         |
| 原生驱动                                      | 闭源，只随官方包       | `@trycua/cua-driver` 0.28.2（MIT） |
| Linux / Wayland                               | 无                     | 自有 `compatible/**`               |

### 本仓库对 `packages/zcode-cua` 做的是整体替换

相对 3.14.3：**删 16、增 38、改 4**。

- 删除的 16 个：全部 `broker-*`（12）+ `pip-session*`（4）
- 新增的 38 个：`compatible/**`（Linux/Wayland 输入后端）、`driver-host`、`helper-transport`、`permissions`、`macos-permissions`、`platform`、`runtime`、`surface`、`surface-target` + 7 个测试

`package.json` 已是 `@trycua/cua-driver@0.28.2` 适配器；`third-party/cua-driver/NOTICE.md` 声明 **No proprietary ZCode binaries are included in this runtime**。

**结论：CUA 运行时这一层已不是上游代码，不能按「换上游」处理。**

### 可 patch 的部分：只有两份纯文本

| 上游文件                                                                | 变化        | 处理  |
| ----------------------------------------------------------------------- | ----------- | ----- |
| `apps/zcode-cli/packages/zcode-cua-plugin/skills/computer-use/SKILL.md` | +380 / -141 | ✅ 取 |
| `apps/zcode-cli/packages/zcode-cua-plugin/docs/computer-use.md`         | +512        | ✅ 取 |

`SKILL.md` 决定 agent 如何使用 CUA，是平台无关的行为规范；纯文本改动零耦合、零风险。

### 不可 patch（依赖已被删除的层或闭源 Helper）

| 上游文件                                                     | 原因                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------- |
| `cuaPipSession.ts` / `cuaPipSessionService.ts`               | import `@zcode/zcode-cua/pip-session`，本仓库已删该契约 |
| `packages/zcode-cua/broker-server.js`                        | 依赖 broker 层，本仓库已删                              |
| `cuaHelperInstaller.ts`                                      | 依赖闭源 Helper                                         |
| `cuaStandaloneStatusLaunch.ts`                               | 依赖 `HELPER_APP_NAME`（闭源 Helper 命名）              |
| `stableCuaTransport.ts`                                      | Windows only（`resolveWindowsCuaRuntime`）              |
| `packages/desktop/src/main/cuaOsSupport.ts`                  | macOS 12.0 地板检查                                     |
| `windowsCuaDevRuntime.ts` / `windowsCuaHelperHostSupport.ts` | Windows，且本仓库已有 3.14.3 版                         |
| `packages/desktop/src/main` 新增 7 个                        | macOS/Windows UI 或 Helper 安装                         |
| `packages/zcode-cua/**`                                      | **占位包，换过去 = CUA 静默失效**                       |

### 只读不 vendor：23 份 CUA 文档

`docs/cua/`（14）+ `docs/cua-permission-broker/`（9），日期 2026-08-18 ~ 2026-09-21。内容是 macOS TCC 独立责任进程模型、LaunchServices `-10825` 事故、Helper 懒启动、archive admission gate、Windows transport。**是 macOS/Windows 的运维记录，进本仓库就是 23 份不适用文档**；按「读过、按需参考」处理。

### 契约文件无需改动

`frame-contract.js` / `host-display-contract.js` / `request-access-contract.js` / `index.js` 在 3.15.1 **零改动**（`package.json` 仅 +1 行）。本仓库的副本仍然有效。

### 不得触碰的守卫

`packages/zcode-cua/test/**`（7 个测试）与 `scripts/ci/cua-driver-runtime-assets.test.mjs` 是本仓库 CUA 运行时**唯一**的守卫——它会抓出运行时被换成 fail-closed 占位的情况。整段 CUA 操作里不得删除或跳过。

## 工作项 4：核心包（暂缓，需单独判断）

上游对 CLI 核心包也大幅扩张：

| 包                         | 3.14.3 | 上游 3.15.1 |  倍数 |
| -------------------------- | -----: | ----------: | ----: |
| `dynamic-workflow`         |    102 |   **2,058** | 20.2× |
| `dynamic-workflow-runtime` |      8 |          27 |  3.4× |
| `bootstrap`                |    234 |         509 |  2.2× |
| `adapters`                 |    204 |         380 |  1.9× |
| `core`                     |    502 |         813 |  1.6× |
| `contracts`                |    115 |         165 |  1.4× |
| `cli`                      |     99 |         135 |  1.4× |
| `tui`                      |     95 |         124 |  1.3× |

**暂缓的理由**：这些与本仓库的 Rust 重写直接重叠。全量跟随会让 fork 变成上游镜像，Rust 重写的意义随之消失。

**待判断**：`dynamic-workflow` 那 2,058 个文件里是否存在本仓库确实需要的能力（注意文件数可能含生成的 fixture，需先看构成）。存在则单独取用，不存在则不动。

## 工作项 5：Browser Use 放开 subagent（已定，本轮执行）

**上游的事实**：3.15.1 移除了 `Browser is not available in subagent`。依据是上游设计变更记录（`docs/design/v2/tool/00-tool-change-chain.md`，2026-10-09）：工具定义、schema、权限与 node_repl MCP 进程都不变，只有两处拒绝被删——`node-repl-host` 的 browser bridge 与 bootstrap 的 node_repl broker。sessionId 的权威校验从「按 `runtime_scope` 一刀切」改成「子会话必须经父 runtime 登记」。

**为什么跟**：这条属于白拿线——它不是新功能，是删掉一个把合法能力挡住的判断；放开后子代理与当前对话**共用 tab**，用户能在面板里看到子代理开的 tab，行为可观察、可回滚。

**为什么 CUA 不跟**：CUA 拒绝 subagent 的理由是它会抢用户桌面焦点，且拦截在两层（`core/src/subagent/computer-use-policy.ts` 与 `node-repl-host/src/cua-bridge.ts`）。上游也只放开 Browser。

**不跟的部分**：上游同一批改动里夹着与 subagent 无关的 3.15.1 内容（模型选择持久化、provider runtime headers、agent definitions 重构），与本工作项无关。

设计、状态所有者与事件顺序见 [`browser-subagent-shared-tabs.md`](./browser-subagent-shared-tabs.md)。

## 迁移时必须同步修改的清单与契约

换插件不是只换目录——下列位置枚举了插件名或插件清单路径，必须一起改。

| 位置                                                                       | 为什么                                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts` | 官方插件定义                                                                                     |
| `packages/desktop/bundled-remote-assets/manifest-linux-x64.json`           | 列了 16 处 `.zcodium-plugin/plugin.json` 路径                                                    |
| `packages/desktop/bundled-agents/<platform>/glm/packages/*`                | 随包 agents                                                                                      |
| `packages/desktop/mock-cdn/releases/*/glm/*/packages/*`                    | 多份发行快照（`3.14.0`、`3.14.3`、`3.14.3-20261009.261`、`-263`、`-269`、`3.14.3-20261010.269`） |
| `third-party/copied-components.json`                                       | 派生组件台账                                                                                     |

CI 守护（会红，必须一起处理）：

- `scripts/ci/builtin-plugin-assets.test.mjs`
- `scripts/ci/bundled-remote-assets.test.mjs`
- `scripts/ci/bundled-remote-source.test.mjs`
- `scripts/ci/bundled-plugin-marketplace.test.mjs`
- `scripts/ci/bundled-plugin-marketplace-protocol-smoke.mjs`

## `.zcodium-plugin` → `.zcode-plugin`

本仓库把插件清单目录从上游的 `.zcode-plugin` 改名为 `.zcodium-plugin`：

|             | `.zcodium-plugin` | `.zcode-plugin` |
| ----------- | ----------------: | --------------: |
| 3.14.3      |                 0 |               2 |
| 本仓库      |            **16** |               0 |
| 上游 3.15.1 |                 0 |          **18** |

引用 `.zcodium-plugin` 的位置（改名后必须一起改）：

- `packages/desktop/bundled-remote-assets/manifest-linux-x64.json`
- `plugin-creator-plugin` 的三个脚本：`validate-plugin.mjs`、`upsert-dev-marketplace.mjs`、`scaffold-files.mjs`

注：源码里**没有**对 `.zcode-plugin/`（目录）的引用——`zcode-plugins-official` 是商店 ID，不是目录名，两者不要混淆。

采用上游插件时，这三个脚本会随上游变回 `.zcode-plugin`，因此清单必须同步，否则加载器找不到插件清单。

## 会失效的 spec

| spec                                                                                    | 处理                 |
| --------------------------------------------------------------------------------------- | -------------------- |
| `pdf-plugin-backfill.md`、`pdf-plugin-phase3-qa.md`、`pdf-plugin-phase4-typesetting.md` | 标历史快照           |
| `spreadsheets-plugin-backfill.md`                                                       | 标历史快照           |
| `documents-doc-layer-backfill.md`、`documents-doc-layer-cleanroom.md`                   | 标历史快照           |
| `image-search-local-backend.md`                                                         | 标历史快照           |
| `plugin-backfill-openbase-survey.md`、`content-backfill-openbase-survey.md`             | 标历史快照           |
| `builtin-plugin-parity.md`                                                              | 部分失效，需逐节判定 |

**建议标记为历史快照而非删除**——那批 audit 结论（键级判定、许可排查、被排除的基座）仍有查证价值，且删除会让 `rolling-update.md:208`、`provider-config-menu-entry.md:26` 的引用悬空。

上游对账政策（`upstream-i18n-parity.md`、`upstream-parity-audit.md`）是否需要调整，**待明确**；本次只记录「上游代码按 scoped diff 跟、不做 parity 对账」这一倾向，不擅自改动这两份 spec。

## 不做什么（Non-goals）

- 不做 `git merge` / `git rebase` 上游——上游是代码倾倒，合并只会制造无意义的冲突
- 不换 `packages/zcode-cua/**`（占位包）
- 不 vendor 那 23 份 macOS/Windows CUA 文档
- 不放宽 CUA 的 subagent 限制（只放开 Browser Use，见工作项 5）
- 不整包跟随 `dynamic-workflow` 等核心包
- 不为了「保持新鲜」而同步

### 故意不跟、且要一直不跟的（下次同步别再引入）

| 类别                                             | 上游文件 / 目录                                                                                                                                                                                    | 为什么不要                                                                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 遥测与内容录制                                   | `packages/shared/src/{telemetry,telemetryRedaction,remoteUsageTelemetry,sessionCreateTelemetry,rendererActionTrace}.ts`、`api-key-usage-scene.ts`；`packages/services/src/usage-stats`、`feedback` | 本仓库已有 `TELEMETRY_REMOVAL.md`：官方与专有上报实现、自动身份归因、内容录制均已删除，只保留本地诊断与用户可显式开启的 OTLP 出口 |
| 商业与增长                                       | `coding-plan-subscription.ts`、`rewardsBridge.ts`、`rewardsEmbedded.ts`、`marketingTouch.ts`、`highspeed.ts` 及其 services 侧同名目录                                                              | 订阅/奖励/推广不属于本 fork 的产品面                                                                                              |
| 闲时任务（off-peak）                             | `zcodeOffPeak*` 协议族（create / list / permission mode / task snapshot / tool policy）、`contracts/src/interfaces/off-peak.port.ts`、`contracts/src/tools/off-peak.ts` | 本仓库已主动退休：协议侧 `retiredIdleExecutionGuardSchema` 用 `z.never()` 拒绝 `offPeakTaskId`/`offPeakRunType`，`assertNoRetiredIdleExecution` 拒绝 `offpeak-` 前缀输入 id 与 `OffPeakCreate` 工具；闲时算力需要订阅账号与服务端调度 |
| `packages/zcode-cua/**` 的 broker 与 pip-session | `broker-*.js`、`pip-session*.js`                                                                                                                                                                   | 本仓库已删该层，改用 `@trycua/cua-driver`（见工作项 3）                                                                           |
| 上游 vendoring 的 superpowers 快照               | `superpowers-plugin/hooks/**` 等                                                                                                                                                                   | 那份比我们旧，而且 hooks 在我们这边不会被加载（见工作项 2 的例外段）                                                              |
| 测试入口差异                                     | 上游根的 `vitest.config.ts` / `vitest.setup.ts` / 根 `specs/`                                                                                                                                      | 本仓库用 `node:test`（含 `scripts/ci/*.test.mjs`）与 `.agents/specs/`；不为了对齐上游而再引入一套 runner                          |

## 验收场景

1. **协议**：每个上游版本发布后执行 scoped diff，并明确记录「已核对」或「已跟进」；不得跳过。
2. **插件**：换完之后 `node --test --test-isolation=none scripts/ci/*.test.mjs` 必须全绿，尤其是上列 5 个 bundled/plugin 守护测试。
3. **CUA**：`packages/zcode-cua/test/**` 与 `scripts/ci/cua-driver-runtime-assets.test.mjs` 必须仍然通过；CUA 运行时与 `@trycua/cua-driver` 依赖不得变动。文档层可以补，但只能写本实现支持的面。
4. **改名**：`.zcodium-plugin` → `.zcode-plugin` 完成后，`packages/desktop/bundled-remote-assets/manifest-linux-x64.json` 与 `plugin-creator-plugin` 三个脚本必须与之一致。
5. **Browser 放开**：见 `browser-subagent-shared-tabs.md` 的验收场景；`node-repl-host` 的 package / manifest / serverInfo / 官方 seed 定义 / SEA 清单五处版本必须一致。
6. **不回归**：`pnpm typecheck`、`pnpm lint` 与基线一致。

## 进度

| 工作项                            | 状态                                                                                                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 协议 delta                     | **已核对（第二轮补全口径，见「补充清单」）**：MCP UI 实例与 MCP resource read 两边都有；`zcode-protocol/trace.ts` 只是上游拆了文件（我们的 `zcodeProtocolTraceSchema` 内联在 `index.ts:285`，字段一致）；其余新增面逐项判定为「不跟（我方没有的产品能力）」或「归入工作项 6」 |
| 2. 插件换上游（含前置 diff 判断） | **本轮做完 12 个**：skill-creator、visualize、plugin-creator、zcode-guide、pdf、documents、presentations、spreadsheets、android-emulator（+构建）、ios-simulator（+构建）、restore-legacy-sessions、superpowers（改为整理，不换） |
| 3. CUA 只取文本                   | **已做**（早已执行 + 本轮按缺口补，见工作项 3）                                                                                                                                                                                   |
| 4. 核心包判断                     | 待做（**构成分析已完成**，见「补充清单」工作项 4：`dynamic-workflow` 2,058 个文件里 1,575 个是图分析期望输出快照，源码只有 120 个 `.ts/.tsx`） |
| 5. Browser 放开 subagent          | **已做**（`58b4952a`，设计见 `browser-subagent-shared-tabs.md`）                                                                                                                                                                  |
| 6. 远控分片与确认式中继           | **已评估，未实现**（见 `web-remote-control-acked-relay.md`：这是我们自己注释里写明的 P5，上游已实现，建议单独立项）                                                                                                               |
| 清单与契约同步                    | **本轮同步做了 5 类**：`builtinPluginAssets.ts` 的 seed 清单、`official-plugin-definitions.ts` 的三处版本、`requiresRuntime` 与构建脚本、根 `NOTICE.md`、`third-party/copied-components.json` 台账                                |
| `.zcodium-plugin` 改名            | **已定：保留我们的名字**（上游用 `.zcode-plugin`），本轮所有新换插件都改回 `.zcodium-plugin`，此项结束                                                                                                                            |
| spec 标历史快照                   | 待做                                                                                                                                                                                                                              |

### 本轮新增的两个决定

- **image-search 不换**：上游那份指向官方搜图服务并用 ZCode JWT 鉴权，换成它等于把用户的登录凭据
  发往该服务。本仓库的版本按 `image-search-local-backend.md` 只连用户自己配置的端点，本轮只补了
  一份中文 README，并把版本 `0.2.0 → 0.2.1`（仅文档变化也要让已装用户拿到）。
- **restore-legacy-sessions 的源与目标是两个不同的根**：源保持 `~/.zcode/v2/sessions`
  （ACP 时代的 ZCode 数据，只读），目标改为 `~/.zcodium-exp/{v2,cli}`（本仓库自己的数据根，
  见 `appDirNames.ts` 的 `ZCODE_USER_DATA_DIR_NAME`）。两个脚本里都加了注释说明这一点。

## 补充清单（第二轮：把「已核对」做成真的逐项判定）

第一轮把工作项 1 记成「已核对」，实际只核了三个新增面（MCP UI 实例、MCP resource read、
topic resource relay），漏了其余改动；工作项 4 / 6 也没动。第二轮按下面的口径重做了一遍。

### 判定口径与命令

```bash
# fork 点、上游目标、我们的 HEAD
M=872ad960   A=aac47556

# 「上游改过、我们树里仍存在、且我们从未碰过」的文件
git diff --name-only $M $A | sort > /tmp/up.txt
git diff --name-only $M main | sort > /tmp/ours.txt
git ls-tree -r --name-only main | sort > /tmp/tree.txt
comm -23 /tmp/up.txt /tmp/ours.txt | grep -Fxf /tmp/tree.txt > /tmp/cand.txt   # 1,079 个
```

逐个再核两件事，缺一不可：

1. **这个改动在我们这边成立吗**——很多上游改动依赖我们没有的结构（例如 `RemoteTarget`
   的 `server` 种类、`guarded` 模式、`bot_topic_context` 生产者），拿过来就是死代码；
2. **我们是不是已经自己修过同一条问题**——第一轮就撞上两次：
   - `bootstrap/src/zcode-protocol/session-mapper.ts`：我们早已把 `mapModelRequestPayload`
     改成只映射 `messageCount`（注释写着「之前映射成 session.updated 后会把全量上下文反复推给
     桌面」），上游修的是另一半（内存 store 驻留），两边互补；
   - `core/src/tool/executor/permission-flow.ts`：授权应答里的规则持久化与失败转工具错误
     我们本来就写在 flow 里，上游只是把它搬进 `permission-rules-persistence.ts`；
   - `core/src/subagent/tool-event-mirror.ts`：交互镜像在我们 fork 点就有，上游只是抽出
     `mirrorSubagentInteractionEvent` 供 dwf actor 复用。

去空白比对还能区分「纯格式化重排」与真改动（`-w` 抓不到换行重排）：

```bash
diff -q <(git show $M:"$f" | tr -d '[:space:]') <(git show $A:"$f" | tr -d '[:space:]')
```

1,079 个候选里，纯空白差异只有 11 个（`.vscode/*`、几个 tsconfig、`README.md` 等），
其余 1,068 个都有实质内容变化——所以目录计数（`packages/ui` 411、`.agents` 133、
`core` 120、`desktop` 74、`bootstrap` 55、`services` 46 …）不能直接当成待办量。

### 本轮补搬的三项（附我们已有的那一半）

| 项 | 上游改动 | 我们这边的状态 | 处理 |
| --- | --- | --- | --- |
| 内存 event store 的 `model_request` 驻留瘦身 | `session-event-retention.ts` 新增 `slimRetainedModelRequest`，`in-memory-session-event-store.ts` 在淘汰节拍使用 | 我们已自修「推给桌面」那一半（映射只留 `messageCount`）；驻留副本仍带全量 `messages`，随轮次线性涨 | 搬，并**同时**改 `mapModelRequestPayload` 认 `messageCount`，否则条数会被读成 0 |
| `isMainAgentToolProjectionSource` 识别 Claude 子代理 | 读 `_meta.claudeCode.parentToolUseId` | 只认顶层 `parentToolUseId`，子代理 TodoWrite 会覆盖主任务摘要 | 搬 |
| TUI 分发 smoke | 匹配前 `stripVTControlCharacters` | 原始 PTY 文本里提示词被 SGR 序列打断，CI 会假超时 | 搬 |

同时把上游对应测试搬进 `apps/zcode-cli/packages/contracts/test/`（node:test，19 例：
RET-001/002/003/004/005/008/009/011）。`@zcode/contracts` 此前没有测试也没有 `test` 脚本，
现在补了 `test` 脚本与 `tsx` devDependency。

**注意**：`apps/zcode-cli/packages/*` 的包级测试目前**不在 CI 门禁内**——CI 只跑
`scripts/ci/*.test.mjs` 与 `packages/zcode-cua/test/*.test.mjs`。这批测试目前只有
`pnpm --filter @zcode/contracts test` 这个入口；要不要把它接进 CI 是一独立决定。

### 有实质改动但我们不搬（逐项理由）

| 文件 / 区域 | 上游改动 | 不搬的理由 |
| --- | --- | --- |
| `packages/shared/src/errors.ts` | 新增 `isNonRetryableWorkspacePrepareError` 等 | 消费者是 `ui/src/lib/workspacePrepareRetry.ts`，我们仓库没有该文件也没有对应预热路径 |
| `server/src/remote/create-backend.ts`、`shared/src/remoteEnvironmentKey.ts` | 新增 `server` target 分支 | 我们的 `RemoteTarget = SSH \| WSL \| Docker`，没有 `server` 种类 |
| `shared/src/zcode-protocol-v4/workflow-run-settings-command.ts` | 注释语义改为「默认并发、无上限」 | 我们的实现仍按本机上限钳制，照抄注释会写反我们的行为 |
| `shared/src/conversation-message-projection-policy.ts`、`zcode-protocol-legacy-types.ts` | 新增 `agent_listing_delta` / `bot_topic_context` synthetic source | 全仓 0 命中，没有生产者；属于上游 agent listing / bot topic 能力 |
| `shared/src/providers.ts` | `ZCODE_PROVIDERS` 加 `export` | 无消费者，纯 API 面扩张 |
| `scripts/third-party-npm.mjs` | 改为按锁文件 `os/cpu/libc` 过滤生产依赖 | 我们的 notices/licenses 不在 CI 门禁（`licenses.mjs` 的 `check` 是手动门禁），且需要 `yaml` 与 `supportedArchitectures` 支持；单独评估 |
| `browser-use-plugin/scripts/build.mjs` | `external: ["sharp"]` | 我们的依赖图里没有 `sharp`（锁文件 0 命中），改了是空操作 |
| `browser-use-plugin/{README,package.json}` | license Apache-2.0 → MIT、加 vitest | 许可事实不能随构建配置默认接受；测试入口按本仓库口径 |
| `core` 四项：`compact-active-helpers`、`prompt-admission`、`tool-event-mirror`、`permission-input-recheck` | 分别是常量导出、`requireQueue`（Highspeed 路径）、dwf actor 用的导出、guard 上下文重构 | 全部绑定我们没有的功能（Highspeed / guarded / dwf）或我们已有的等价行为；`permission-capability` 的 `mode`/`bashShellSelection` 也只在 guarded 复用重判路径上才成为问题 |
| `permission-rules-persistence.ts` 的 session scope 分支与 `applyGrantedPermissionUpdates` | 群协作/session 级授权规则 | `PermissionRuleset.scope`、`approvalMode`、`inputAdjustments`、`registered` 都是 dwf/群协作契约；持久化与失败转错误我们 flow 里已有 |
| `services/.../claudeNativeSessionImportParser.ts` 新增导出、`importedClaudeHistoryRepair.ts` | 轮次选择 / 未知命令诊断 / 导出放宽 / 改 `readFileSync` | 新导出**上游自己也没有消费者**（`git grep` 只命中定义处）；`readFileSync`+`existsSync` 还与我们「异步 IO」规则相反，不跟 |
| `ui/src/lib/chatAttachments.ts` | 新增 `restoreChatComposerAttachment`（含大小/缺内容校验） | 我们没有这个恢复入口（`rg 'restoreChatComposerAttachment'` 0 命中）；`MissingInline*` 错误类与 v4 composer 的 catch 分支我们已有，但抛点不存在 |
| `ui/src/lib/zcodeSessionProjection.ts` | 3,433 行改动 | 是上游 UI 的整体演进，不是单个修复；里面的会话投影修复要单独取 hunk |

### 未立项区域（UI / Desktop / Services）的判定：部分跟

上游改动量：`packages/ui` 1,005 个文件、`desktop` 229、`services` 238；筛掉我们碰过的之后
分别剩 409 / 71 / 43。抽样结论大约 **2/3 是新功能与新界面、1/3 是既有行为的修复**，
不能整体归成「自有产品面，全不跟」，也不能整包跟。

建议记为 **「部分跟：按文件评估维护类修复，不跟上游产品面演进」**。目前值得单独立项评估的：

1. `packages/ui/src/lib/zcodeSessionProjection.ts`：权限拒绝后工具卡永久转圈、后台 Agent
   启动 ACK 被显示成完成、`/rewind` 控制响应被渲染成聊天气泡、token/usage 恢复。
2. `packages/ui/src/lib/chatAttachments.ts` 与 `v4/composer/attachmentUpload.ts`：
   元数据态附件（无 `localPath`/`dataBase64`）现在是在**发送时静默丢弃并打日志**，
   上游改成在恢复阶段结构化拒绝——要不要改成用户可见拒绝是产品决定。
3. `packages/services/src/session/claude-native/claudeNativeSessionImportParser.ts` 的
   轮次选择逻辑（等上游接上消费者再取，避免先造死代码）。

桌面端 71 个候选抽样以接口/导出扩展为主，未发现必须跟的行为修复；主进程与 Host 的大改文件
多已被我们改过，需另做定界审计。

### 工作项 4 的构成分析（先看构成，再决定取不取）

```bash
git ls-tree -r --name-only $A -- apps/zcode-cli/packages/dynamic-workflow | wc -l   # 2,058
git ls-tree -r --name-only $M -- apps/zcode-cli/packages/dynamic-workflow | wc -l   # 102
git ls-tree -r --name-only main -- apps/zcode-cli/packages/dynamic-workflow | wc -l # 102
```

上游那 2,058 个文件里：`tests/` 1,928 个（其中 `tests/graphs/expected/` 固定期望输出 **1,575** 个），
`src/` 下 `.ts` 源码 **120** 个，文档/配置/样例其余。所以「20.2 倍」不是实现量，
而是图分析测试快照。我们的包（102 个文件）本来就在跑（`bootstrap`/`cli` 声明依赖，
`dynamic-workflow-run-launch.ts` 等调用），需要判断的只是 `src` 增量（hole / engine / analysis）。

结论：**不整包搬**；要取就按能力取 `src` 增量，测试快照不 vendor。

### 本轮仍未做

| 项 | 说明 |
| --- | --- |
| 工作项 6（远控分片与确认式中继） | 仍是最大缺口：协议 `TOPIC_RESOURCE_RELAY_*` + 4 个 schema、`zcodeEndpoint.ts` 的 relay WS 地址解析、`server/src/stdio.ts` 的 reverse ChannelClient、client 侧 ≈989 行、shared 侧 766 行。开工前必须先定 `web-remote-control-acked-relay.md` 里的三条前置 |
| 工作项 4 | 取不取 `dynamic-workflow` 的 `src` 增量 |
| spec 标历史快照 | 8 份 backfill spec |
| `third-party-npm.mjs` 平台过滤 | 单独评估（会影响生成 `THIRD-PARTY-NOTICES.md` 的路径） |
| 包级测试接进 CI | 见上文「注意」 |

## 附：测量口径

本文所有数字均由本仓库对 `upstream/main` 与 `29628c9` 的 git 树直接测量，非引用第三方：

- 文件数：`git ls-tree -r --name-only <rev> -- <path> | wc -l`
- 行数：`git diff --shortstat <old> <new>` 或 `git archive <rev> <path> | tar -x` 后对 `.ts`/`.tsx` 执行 `wc -l`
- 平台相关性判定：对目标路径 grep `wayland|gnome|driver|compatible|x11|linux` 与 `darwin|win32|windows`
- 引用扫描：对 `packages/`、`apps/`、`scripts/`、`.github/` grep，排除 `node_modules` 与 `dist/`

引用上游版本时必须写明 commit 或版本号；`--diff-filter=A` 在整树替换式发布上会与 `-D` 配对出现，判断「新增」时需交叉核对两棵树的存在性，不能只依赖单一方向。
