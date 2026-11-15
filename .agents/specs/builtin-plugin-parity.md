# 闭源内置插件对齐（Built-in Plugin Parity）

> **逐节判定（上游 3.15.1 同步后复核）**：共 10 节 —— **有效 1 节**（seed 校验闸门）、**失效 3 节**（排除、documents seed 清单、Computer Use 分层核对）、**部分有效 6 节**（背景、纳入、状态所有者与契约、验收场景、实测结果、非目标）。
> 主要取代者：`packages/shared/src/builtinPluginAssets.ts` 的单一 seed 源，以及把 11 个插件换成上游实现的提交 `6c821746`/`16f01a28`/`75163cc3`/`8b40ef5f`/`69be408e`。

## 背景

> **判定：部分有效**。`44b25ed46c` 的历史成因与 staging 清单错配仍可查证；但「相对官方安装包缺少 12 个内置插件」的现状描述已被 3.15.1 同步取代——当前有 16 个 `.zcodium-plugin/plugin.json`。
> 证据：`find apps/zcode-cli/packages -maxdepth 3 -name plugin.json | wc -l` = 16；上述插件替换提交。

开源仓库相对官方 3.14.1 安装包缺少 12 个内置插件。差异来自开源提交
`44b25ed46c`「remove bundled plugins except browser use and cua」：该提交删掉了除
browser-use 之外的插件源码，但 `scripts/prepare-prebuilds.mjs` 的 staging 清单当时
未同步收敛，导致 `bootstrap:with-remote` 在 staging 第一个 manifest 时就抛
`missing remote official plugin manifest`。

插件源码归属 `apps/zcode-cli/packages/`。发行清单只包含资源完整且满足 seed 契约的插件；
桌面 staging、远端资源和 bootstrap 注册保持一致，不因资源缺失而降低完整性校验。

## 范围

### 纳入

> **判定：部分有效**。表内 8 个包名仍都是官方插件、目录形态大体成立；但表格已不是当前全集——`BUILTIN_PLUGIN_SEED_PATHS` 现有 16 项，新增 pdf / spreadsheets / visualize / android-emulator / ios-simulator / superpowers 未列。`documents`（seed 42 项）与 `image-search`（改接用户自配端点）的「运行时依赖」描述也已被上游版 / 本地版改写。
> 证据：`packages/shared/src/builtinPluginAssets.ts` 的键集合；`git ls-tree aac47556 -- apps/zcode-cli/packages/documents-plugin | wc -l` = 44，与本仓库同级。

| 包                                      | 内容形态                                         | 运行时依赖                          |
| --------------------------------------- | ------------------------------------------------ | ----------------------------------- |
| `@zcode/presentations-plugin`           | skills + agents（PPTX）                          | 无                                  |
| `@zcode/documents-plugin`               | skills + agents + scripts（DOCX）                | 无（Python 脚本由宿主执行）         |
| `@zcode/skill-creator-plugin`           | skills                                           | 无                                  |
| `@zcode/plugin-creator-plugin`          | skills + scripts（纯 `.mjs`，无构建）            | 无                                  |
| `@zcode/image-search-plugin`            | `.mcp.json`（HTTP MCP）                          | 指向官方后端                        |
| `@zcode/restore-legacy-sessions-plugin` | skills + commands                                | 无                                  |
| `@zcode/zcode-guide-plugin`             | skills + commands                                | 无                                  |
| `@zcode/zcode-cua-plugin`               | SDK client + skill + docs                        | 原生执行由 node_repl host 提供      |
| `@zcode/design-plugin`                  | 技能 + design-resources 资源 + SessionStart hook | 无（纯内容，默认关闭，3.18.2 同步） |

### 排除

> **判定：失效（被 3.15.1 同步取代）**。① `android-emulator` / `ios-simulator` 已纳入并补了 `scripts/build-mcp.mjs` 构建（提交 `8b40ef5f`；`BUILTIN_PLUGIN_SEED_PATHS` 含 `dist/mcp/server.js`，`requiresRuntime` 为 true）。② CUA 已按 5 模块移植（`computer-use-client/errors/envelope/target/keys.mjs`，client 340 行），远端清单 `packages/desktop/bundled-remote-assets/manifest-linux-x64.json` 已列出 `packages/zcode-cua-plugin/**`，「远端不接收 CUA」不再成立。③ `image-search` 未换上游，仍是用户自配端点的本地版（manifest 的 `userConfig.imageSearchMcpUrl`），不再涉及官方签名后端。
> 证据：`find apps/zcode-cli/packages -maxdepth 3 -name plugin.json`；`rg -n 'cua-plugin' packages/desktop/bundled-remote-assets/manifest-linux-x64.json`；`cat apps/zcode-cli/packages/image-search-plugin/.mcp.json`。

- `@zcode/android-emulator-plugin`、`@zcode/ios-simulator-plugin`：
  含原生 `.cc/.h/.node` 产物，不属于纯内容移植，单独排期。
- **CUA 的原生 runtime**：闭源侧 `zcode-cua-plugin/node_modules` 里有 koffi/sharp/detect-libc
  共约 20 MiB，是真正驱动鼠标键盘的部分。它不在 `requiredSeedPaths` 里，
  `official-plugin-definitions.ts` 也显式声明 `runtimeTopLevelPaths: []`。
  本次只移植 `scripts/computer-use-client.mjs`（模型可见面，只依赖 node: 内建模块）、
  `skills/computer-use/SKILL.md`、`docs/computer-use.md` 三项。
  远端工作区**有意不接收 CUA**：原生执行依赖 node-repl-host 的 `dist/mcp/server.js`，
  而宿主 runtime 不向远端发布；把 CUA 加进远端合同只会 seed 出看得见却调不到的残缺插件。
- 任何需要后端签名的能力（`image-search` 的 MCP 即属此类）：只移植契约，不保证
  离线可用；这点与闭源行为一致，不是缺陷。

## 状态所有者与契约

> **判定：部分有效**。四个位置都还在，但「四处逐字一致」已改成「单一源派生」：`packages/shared/src/builtinPluginAssets.ts` 的 `BUILTIN_PLUGIN_ASSETS` 现在被 `scripts/prepare-prebuilds.mjs:61`、`packages/desktop/scripts/prepare-agent-node-bundle.mjs:80`、`packages/server/src/remote/zcodeAgentOfficialPluginAssets.ts:11` 直接引用；后者符号已改名（不再是 `..._ASSET_PATHS`，而是 `REMOTE_AGENT_OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS` / `REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS`）。bootstrap 侧 `official-plugin-definitions.ts` 仍独立枚举 16 个定义。
> 证据：`rg -n 'BUILTIN_PLUGIN_ASSETS|REMOTE_AGENT_OFFICIAL_PLUGIN' scripts packages`。

3.18.2 同步补记：`@zcode/design-plugin` 是纯内容型内置插件（入口技能 + `design-resources/**` +
`hooks/{hooks.json,run-hook.cmd,design-rules}`，无 MCP / 无原生依赖 / 无构建脚本），
`BUILTIN_PLUGIN_SEED_PATHS["design-plugin"]` 是它唯一的 seed 清单，`official-plugin-definitions.ts`
与 SEA 脚本都从这一处派生，`requiresRuntime` 为 false。上游 `packages/design-plugin` 逐字节随包
（`.zcode-plugin/` 改名 `.zcodium-plugin/`，上游 `.claude-plugin/` 不随包；`BUILTIN_PLUGIN_TOP_LEVEL_PATHS`
本就不含它），来源与许可登记在 `third-party/copied-components.json`（Open Design 0.7.0 及各子技能）。
默认关闭，避免首启就给所有会话注入新技能。详见 `.agents/specs/upstream-3.18-plugins-node-repl.md` §4。

插件是否进入安装包，由 **四处清单共同决定**，必须逐字一致：

| 位置                                                                                                                              | 职责                        |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts` → `OFFICIAL_PLUGIN_DEFINITIONS`                        | bootstrap 注册与 seed 校验  |
| `scripts/prepare-prebuilds.mjs` → `remoteOfficialPluginPackages` / `remoteOfficialPluginRequiredPaths`                            | 远端 shared-host staging    |
| `packages/desktop/scripts/prepare-agent-node-bundle.mjs` → `officialPluginPackages`                                               | 桌面 agent node bundle seed |
| `packages/server/src/remote/zcodeAgentOfficialPluginAssets.ts` → `REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES` / `..._ASSET_PATHS` | 远端合同                    |

### seed 路径是校验闸门，不是复制过滤器

> **判定：有效**。`bundled-plugins.ts` 的 `findMissingOfficialPluginSeedPaths` 仍抛 `ZCODE_PLUGIN_SEED_INCOMPLETE`；顶层白名单除正文列出的项外又加了 `NOTICE.md`、`LICENSE`；`OFFICIAL_CUA_REQUIRED_SEED_PATHS` 仍为 7 项。
> 证据：`apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts:40,126,323`；`packages/shared/src/builtinPluginAssets.ts` 的 `zcode-cua-plugin` 7 项。

顶层白名单（`bundled-plugins.ts` 的 `includedTopLevelPaths`、`prepare-agent-node-bundle.mjs` 的
`includedOfficialPluginTopLevelPaths`）决定**复制哪些目录**，已覆盖 `.mcp.json`、`.zcodium-plugin`、
`README.md`、`agents`、`commands`、`dist`、`docs`、`hooks`、`output-styles`、`package.json`、
`scripts`、`skills`、`templates`。`requiredSeedPaths` 只决定**缺项时是否拒绝 seed**
（`bundled-plugins.ts` 的 `findMissingOfficialPluginSeedPaths` 抛 `ZCODE_PLUGIN_SEED_INCOMPLETE`，
`prepare-agent-node-bundle.mjs` 直接 throw）。

因此 `requiredSeedPaths` 仍应逐项列出插件运行真正依赖的文件：只列两个 markdown 能让校验通过，
却挡不住拷贝被截断，最终装出一个「看得见技能、import 不到脚本」的残缺插件。
`OFFICIAL_CUA_REQUIRED_SEED_PATHS` 从 3 项扩到 7 项正是这个原因。

### documents-plugin 的 seed 清单

> **判定：失效（被上游 documents-plugin 取代）**。当前 `BUILTIN_PLUGIN_SEED_PATHS["documents-plugin"]` 为 42 项，不再是「两个 markdown + 8 个 Python 模块 + 5 个 OOXML 模板」——上游版把 references / routes / scenes / env_setup 整体随 `skills/docx/**` 交付。`documents-plugin` 与 `aac47556` 的内容逐 blob 一致，仅 manifest 目录名不同。
> 证据：`awk '/"documents-plugin": \[/{f=1} f{print} /^  \],$/{if(f)exit}' packages/shared/src/builtinPluginAssets.ts | grep -c '^    "'` = 42。
> 本节的「唯一写入路径」一段仍成立。

`documents` 的 `requiredSeedPaths` 为 15 项：两个 markdown、8 个 Python 模块、5 个 OOXML 模板。
Python 脚本是技能正文描述的全部能力的执行体，缺任一项都会让 `SKILL.md` 指向不存在的工具。

顶层白名单 `remoteOfficialPluginTopLevelPaths` 已覆盖 `.zcodium-plugin`、`agents`、
`commands`、`docs`、`skills`、`scripts`、`package.json`，**本次不需要扩容**。

**唯一写入路径**：插件源码只存在于 `apps/zcode-cli/packages/<name>/`，安装包内的
`resources/glm/packages/<name>/` 由 staging 生成，不允许手工编辑。

## 验收场景

> **判定：部分有效**。第 2 / 3 / 5 / 6 条仍成立（以 `pnpm typecheck`/`lint` 为准；`pnpm-workspace.yaml` 已含 `apps/zcode-cli/packages/*`；`git ls-files` 无 node_modules/.venv/**pycache**/\*.pyc；documents 仍在各处清单）。第 1 条对 `zcode-cua-plugin` 不成立——其 manifest `name` 为 `computer-use`，不等于包名后缀 `zcode-cua-plugin`；第 4 条「四处逐字一致」已变为单一源派生（见上节）。
> 证据：`git ls-files apps/zcode-cli/packages | rg -c 'node_modules|__pycache__|\\.pyc$|\\.venv'` = 0；`cat pnpm-workspace.yaml`；逐包对比 manifest / package 名。

1. 每个包都存在 `.zcodium-plugin/plugin.json`，且 `name` 与 `package.json` 的
   `name` 后缀一致。
2. `pnpm typecheck` 与 `pnpm lint` 保持基线（0 error；warning 不新增）。
3. 新增包被 `pnpm-workspace.yaml` 的 `packages/*` 自动纳入，无需改 workspace 配置。
4. 四处内容插件清单一致，且 `stagedPath` 均为 `packages/<dir>`。
5. 不引入 `node_modules`、`.venv`、`__pycache__`、`*.pyc`（staging 过滤器已排除，
   提交时也不得带入）。
6. **documents 注册回归**：四处清单均含 `documents`；staging 与 desktop seed
   校验通过，不抛 `missing remote official plugin manifest` 或
   `missing staged official plugin seed asset`。

## 实测结果（2026-09-21）

> **判定：部分有效**。CUA 五模块拆分仍成立（`scripts/computer-use-client.mjs` 340 行 + errors/envelope/target/keys）；但 typecheck / lint / `git stash` 复跑是 2026-09-21 的快照，随后上游替换改动了插件包内容，数字与失败清单不再可复现。
> 证据：`wc -l apps/zcode-cli/packages/zcode-cua-plugin/scripts/*.mjs`（client 340）；`git log --oneline` 中的插件替换提交。

| 命令                                  | 结果                                                     |
| ------------------------------------- | -------------------------------------------------------- |
| `pnpm typecheck`（root）              | 通过，0 error                                            |
| `pnpm --dir apps/zcode-cli typecheck` | 28/28 任务通过                                           |
| `pnpm lint`（root）                   | 70 warnings / **0 errors**                               |
| `pnpm --dir apps/zcode-cli lint`      | `@zcode/cli`、`@zcode/contracts`、`@zcode/adapters` 失败 |

CLI lint 的失败**全部为既有基线失败**，与本变更无关：已用
`git stash push -u` 回到干净基线复跑，失败集合完全一致（8 successful / 15 total，
同样失败 `@zcode/cli#lint` 与 `@zcode/contracts#lint`）。失败原因均为
`eslint(max-lines)`，落在本变更未触碰的文件上：

- `@zcode/cli`：`src/prompt-command.ts`(540)、`src/run.ts`(514)
- `@zcode/contracts`：`src/events/event-reducer.ts`(517)、
  `src/interfaces/browser-control.port.ts`(480)、`src/model/index.ts`(874)、
  `src/workflow/index.ts`(768)、`src/interfaces/session-store.port.ts`(1077)、
  `src/interfaces/dynamic-workflow-run.port.ts`(408)

新增的 10 个插件包**不声明 `lint` script**，因此不进 turbo lint 图——与仓库既有约定
一致（`browser-use-plugin` 的 lint 也只覆盖 `src`，不覆盖 `skills/` 与 `docs/`）。

`zcode-cua-plugin/scripts/computer-use-client.mjs` 原先是一个 1208 行的单文件
（vendored 长文件）。2026-09-21 的等价重写按 `apps/zcode-cli/AGENTS.md` 的 400 行
上限拆成五个模块，`client` 变为 340 行的装配层：

| 文件                        | 职责                                   |
| --------------------------- | -------------------------------------- |
| `computer-use-client.mjs`   | 装配、绑定、逃逸口、documentation 转交 |
| `computer-use-errors.mjs`   | 错误对象、broker 码映射、重试策略      |
| `computer-use-envelope.mjs` | MCP 结果读取、冷启动重试、投影给宿主   |
| `computer-use-target.mjs`   | App / Window 交互面与目标解析          |
| `computer-use-keys.mjs`     | 键位输入侧规范化                       |

拆模块的连带改动：`bootstrap` 的 `OFFICIAL_CUA_REQUIRED_SEED_PATHS` 与
`scripts/prepare-prebuilds.mjs` 的 `remoteOfficialPluginRequiredPaths` 都从 3 项
扩到 7 项。只 seed `client` 会装出一个看得见 computer-use、首次调用即
`ERR_MODULE_NOT_FOUND` 的残缺插件。

等价性用同一个 mock bridge 同时驱动新旧实现、逐场景比对全部可观测行为（bridge 收到的
调用、`nodeRepl.write`、`emitStructuredResult`、返回值、抛出的错误）来验证：49 个场景
× 3 个平台全部零差异。测试还对单个行为做了变异（`click_count` 默认值、重试策略、
broker 码映射）以确认它真能抓出差异。

## Computer Use 执行链分层核对（2026-09-21）

> **判定：失效（被 `@trycua/cua-driver` 运行时取代）**。`packages/zcode-cua` 现在是 `@trycua/cua-driver@0.28.2` 的适配器（`compatible/**`、`driver-host`、`helper-transport`、`permissions`、`platform`、`runtime`、`surface` 等），不再是 fail-closed 占位；「唯一缺口 / 无法补全」的结论随之作废（`node-repl-host` 也已独立成 seed 单元）。
> 证据：`packages/zcode-cua/package.json` 的 `dependencies`；`ls packages/zcode-cua`；提交 `c34d389e`、`3e93f5ee`。

用户要求优先补全 Computer Use。逐层核对后确认：**可补全的部分已全部补完，
剩余缺口无法从官方安装包补全，且在当前平台不成立。**

| 层                                             | 开源仓库                   | 官方 3.14.1    | 缺口         |
| ---------------------------------------------- | -------------------------- | -------------- | ------------ |
| 模型可见面 `computer-use-client.mjs`           | 已移植                     | 有             | 无           |
| skill + docs                                   | 已移植                     | 有             | 无           |
| host bridge `node-repl-host/src/cua-bridge.ts` | **真实现**（204 行）       | 有             | 无           |
| host broker `node-repl-host/src/cua-broker.ts` | **真实现**（181 行）       | 有             | 无           |
| host 接线 `server.ts`                          | 有                         | 有             | 无           |
| 构建身份 `__ZCODE_CUA_HELPER_BUILD_ID__`       | 有（`tsup.config.ts:108`） | 有             | 无           |
| `@zcode/zcode-cua` runtime                     | **fail-closed 占位**       | 真实现 1.34 MB | **唯一缺口** |
| Helper 二进制 `ZCode Computer Use.app`         | 无                         | 安装包内也没有 | 不可移植     |

### 为什么剩余缺口补不了

> **判定：失效（同上，被 `@trycua/cua-driver` 取代）**。本节对「闭源 Helper 不可移植」的推导已不适用：本仓库改用 MIT 的 `@trycua/cua-driver`（含 Linux/Wayland `compatible/**`），不再依赖 macOS 捆绑 Helper。

真实现位于闭源 `node-repl-host/dist/mcp/server.js`，esbuild 模块边界
`node_modules/@zcode/zcode-cua/dist/index.js` 起于偏移 3,643,400，终于 4,982,852，
共 **1,339,452 字节 / 35,613 行**。已提取核对，内容是 **Helper 管理层**：
`helperInstaller`、`helperVerifier`、`helperRuntimeTrustPolicy`、`helperLauncher`、
`helperLocalDevAuthorization`、`redactHelperDownloadUrl`、`helperLaunchGuard`、
`CuaHelperError`（47 处）。它自己**不做原生调用**——无 koffi、无 CGDisplay/XLib/
SetCursorPos，`sharp` 是 `loadSharp()` 懒加载软依赖（取不到就继续）。

三条硬约束使其无法成为有效补全：

1. **仅支持 macOS**。`resolveCuaHelperInstallPlan` 首行即
   `if (platform !== "darwin") throw new CuaHelperError("install_failed", …)`。
   当前开发平台为 Linux，补进来也必然抛错。
2. **Helper 是捆绑产物，不是下载**。安装计划解析出
   `{ kind: "bundled", appPath }`；官方 Linux 安装包里同样没有这个 `.app`
   （全包唯一可执行文件是 `semver/bin/semver.js`）。
3. **要求捆绑的构建身份**。`ZCODE_CUA_HELPER_BUILD_ID` 为空时显式拒绝：
   "Packaged ZCode is missing its embedded Computer Use Helper build identity;
   refusing an unpinned Helper install"。该值由 CI 注入，本仓库的 define 是
   `process.env.ZCODE_CUA_HELPER_BUILD_ID?.trim() ?? ""`。

此外它是 **esbuild 构建产物而非源码**：35,613 行单文件，与仓库
「单文件默认不超过 400 行」的约定冲突，且无法与上游逐行对齐维护。

### 结论

> **判定：失效（同上，被 `@trycua/cua-driver` 取代）**。「`packages/zcode-cua` 的 fail-closed 占位是正确且如实」的结论与当前实现相反。

`packages/zcode-cua` 的 fail-closed 占位是**正确且如实**的状态：没有 Helper
二进制、没有构建身份、平台不支持，此时返回不可用比返回一个跑不通的堆栈更诚实。
本 spec 范围内 Computer Use 的补全已结束，不再单独立项。

## 非目标

> **判定：部分有效**。`chat.agentSwitch` 等后端 / UI 能力非目标仍成立；「不改动 browser-use / node-repl-host 的既有条目」已失效——Browser Use 已放开 subagent（`58b4952a`），`node-repl-host` 已从 browser-use 拆成独立 seed 单元。
> 证据：`apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts` 的 `OFFICIAL_NODE_REPL_HOST_*`；`git log --oneline --grep=subagent`。

- 不实现 `chat.agentSwitch`、Claude slot mapping、bot 通知、Rewards 领取等需要
  后端或 UI 改造的能力；它们有各自的 spec。
- 不改动 browser-use / node-repl-host 的既有条目。
