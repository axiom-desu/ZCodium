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

## 验收场景

1. **协议**：每个上游版本发布后执行 scoped diff，并明确记录「已核对」或「已跟进」；不得跳过。
2. **插件**：换完之后 `node --test --test-isolation=none scripts/ci/*.test.mjs` 必须全绿，尤其是上列 5 个 bundled/plugin 守护测试。
3. **CUA**：`packages/zcode-cua/test/**` 与 `scripts/ci/cua-driver-runtime-assets.test.mjs` 必须仍然通过；CUA 运行时与 `@trycua/cua-driver` 依赖不得变动。文档层可以补，但只能写本实现支持的面。
4. **改名**：`.zcodium-plugin` → `.zcode-plugin` 完成后，`packages/desktop/bundled-remote-assets/manifest-linux-x64.json` 与 `plugin-creator-plugin` 三个脚本必须与之一致。
5. **Browser 放开**：见 `browser-subagent-shared-tabs.md` 的验收场景；`node-repl-host` 的 package / manifest / serverInfo / 官方 seed 定义 / SEA 清单五处版本必须一致。
6. **不回归**：`pnpm typecheck`、`pnpm lint` 与基线一致。

## 进度

| 工作项                            | 状态                                                   |
| --------------------------------- | ------------------------------------------------------ |
| 1. 协议 delta                     | 待做（scoped diff 路径已补 `zcode-protocol/trace.ts`） |
| 2. 插件换上游（含前置 diff 判断） | 待做                                                   |
| 3. CUA 只取文本                   | **已做**（早已执行 + 本轮按缺口补，见工作项 3）        |
| 4. 核心包判断                     | 待做                                                   |
| 5. Browser 放开 subagent          | 进行中（本轮）                                         |
| 清单与契约同步                    | 待做                                                   |
| `.zcodium-plugin` 改名            | 待做                                                   |
| spec 标历史快照                   | 待做                                                   |

## 附：测量口径

本文所有数字均由本仓库对 `upstream/main` 与 `29628c9` 的 git 树直接测量，非引用第三方：

- 文件数：`git ls-tree -r --name-only <rev> -- <path> | wc -l`
- 行数：`git diff --shortstat <old> <new>` 或 `git archive <rev> <path> | tar -x` 后对 `.ts`/`.tsx` 执行 `wc -l`
- 平台相关性判定：对目标路径 grep `wayland|gnome|driver|compatible|x11|linux` 与 `darwin|win32|windows`
- 引用扫描：对 `packages/`、`apps/`、`scripts/`、`.github/` grep，排除 `node_modules` 与 `dist/`

引用上游版本时必须写明 commit 或版本号；`--diff-filter=A` 在整树替换式发布上会与 `-D` 配对出现，判断「新增」时需交叉核对两棵树的存在性，不能只依赖单一方向。
