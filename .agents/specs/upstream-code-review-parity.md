# 上游 code review 报告的落地对账

上游在 `apps/zcode-cli/docs/code-review-report.md` 留了一份 628 行的自审报告（审查日期
**2026-06-04**，随 v3.15.1 于 **2026-10-10** 公开）。本 spec 把报告里的 P0/P1/P2 与工程化建议
逐项对到当前 checkout，标出「两边都已做」「两边都欠」「只有我们欠」，作为后续重构的工单。

结论先行：**报告的多数 P0/P1 上游确实改了**（God Object 已拆、`modelAdapter?: any` 已消除、
tui 不再依赖 core）。剩下没做的项，**上游同样没做** —— 所以这不是我们落后于上游，是一份
双方共有的欠账，可以按本仓的节奏推进。

## 基准与复现

- 上游基准：`upstream/main`（`0a1fc56d`，2026-10-19），本地已 fetch。
- 本仓基准：`main`。
- 复现命令全部是只读 git/ripgrep，不联网：

```bash
git show upstream/main:apps/zcode-cli/docs/code-review-report.md | sed -n '/^## 4\./,/^## 6\./p'
rg -n "interface PermissionDecisionResult" apps/zcode-cli/packages/
ls apps/zcode-cli/packages/cli/src/tui-*.ts
```

## 逐项对账

| 编号 | 报告项                                | 上游现状                               | 本仓现状                            | 判定         |
| ---- | ------------------------------------- | -------------------------------------- | ----------------------------------- | ------------ |
| P0-A | 统一重复类型定义                      | ❌ `runtime/types.ts` 仍有 4 字段版    | ❌ 同                               | **两边都欠** |
| P0-B | 修复 `modelAdapter?: any`             | ✅ 已修                                | ✅ 已修                             | 都做了       |
| P0-C | contracts 中的业务逻辑函数移出        | 🟡 部分                                | 🟡 `compact`/`rewind`/`memory` 仍在 | 待核         |
| P1-A | 拆分 AgentRuntime God Object          | ✅ `methods/` 归零，`runtime.ts` 40 行 | ✅ 同                               | 都做了       |
| P1-B | 消除 `deps.ts` 集中重导出             | ❌ 仍有                                | ❌ 有，321 行，**131 个文件**引用它 | **两边都欠** |
| P1-C | 拆分 bootstrap 中的子系统             | ❌ 上游同名文件更大                    | ❌ 同上                             | 上游也欠     |
| P1-D | 将 cli 包中 `tui-*` 移入 tui 包       | ❌ **15 个**                           | ❌ **14 个**                        | **两边都欠** |
| P1-E | TUI 不直接依赖 core                   | ✅ 已修                                | ✅ 已修（无 `@zcode/core`）         | 都做了       |
| P1-F | 合并 shared-types 到 contracts        | ❌ 仍有                                | ❌ 52 行空壳                        | 两边都欠     |
| P2-A | 超 400 行文件拆分                     | —                                      | ⚠️ 规则启用但门禁有洞（见下）       | **本仓可做** |
| P2-E | 拆分 cli 单测文件                     | ❌ `cli.unit.test.ts` 4573 行          | ✅ 结构已变，无该文件               | 不适用       |
| §5.2 | `max-lines` lint                      | 仅建议                                 | ✅ 已启用                           | **本仓领先** |
| §5.2 | boundaries lint（tui 不 import core） | 仅建议                                 | ✅ `architecture:check` 覆盖        | **本仓领先** |
| §5.2 | **knip 进 CI**                        | ❌ 报告自述「已配置但未在 CI 执行」    | ❌ 同样没进                         | **两边都欠** |

### P0-A：重复类型两处仍在（可直接修）

`PermissionDecisionResult` 存在两份且**字段数不同**：

| 位置                                | 字段数 | 内容                                                                                                                |
| ----------------------------------- | -----: | ------------------------------------------------------------------------------------------------------------------- |
| `core/src/permission/service.ts:64` |     11 | `decision`/`allowed`/`reason`/`modifiedInput`/`escalated`/`mode`/`ruleId`/`riskLevel`/`sideEffectScope`/`alwaysAsk` |
| `core/src/runtime/types.ts:684`     |      4 | `allowed`/`reason`/`modifiedInput`/`permissionUpdates`                                                              |

`ToolScheduleItem` 同样两份：`core/src/tool/scheduler.ts:18`（8 字段语义）与
`core/src/agent/turn-state.ts:126`（3 字段）。上游现状完全一致，**说明 P0-A 在 06-04 之后没有被处理**。

报告给的方案是「在 `@zcode/contracts` 定义权威版本，core 消费方改为从 contracts 导入，删除 core 重复定义」，
风险自评为「低 — 纯类型迁移，编译器会捕获遗漏」。这条可以直接照做。

### P1-B：`deps.ts` 是当前最重的耦合点

`apps/zcode-cli/packages/core/src/runtime/deps.ts` 321 行，被 **131 个文件**引用。报告原文：

> 每个 methods 文件将 `import { ... } from "../deps.js"` 改为直接从 `@zcode/contracts` 导入

它与 P1-A 是同一件事的两面：P1-A（拆 God Object）已完成，**但 `deps.ts` 留下了新的集中重导出**，
所以「依赖边界不可见」的问题只是换了个载体，没有消失。

**本仓的特殊性**：我们 Rust 侧 `crates/core` 明确「不做 IO、端口定义在 `core-api`」（见
`apps/zcode-cli-rust/CONTRACT.md`），TS 侧的 `deps.ts` 与这条标准直接冲突。两侧标准不一致会在
继续推进时变成摩擦。

### P1-D：`tui-*` 仍在 cli 包（两边都欠）

|            |                                   上游 |                           本仓 |
| ---------- | -------------------------------------: | -----------------------------: |
| `tui-*` 数 |                                     15 |                             14 |
| 差异       | 有 `tui-auth.ts`、`tui-login-state.ts` | 有 `tui-model-availability.ts` |

差异由产品决定造成，不是遗漏：上游保留了官方登录流程，本仓已移除登录、改为本地模型配置
（`18de1b4e "refactor(cli): remove official login flows and guide local model setup"`）。

本仓 14 个文件共 1371 行：

```
tui-command-data.ts 80        tui-prompt-handler-queries.ts 78
tui-command-state.ts 56       tui-prompt-handler-runtime.ts 81
tui-command.ts 121            tui-prompt-handler.ts 375
tui-model-availability.ts 17  tui-runtime-loader.ts 143
tui-session-event-relay.ts 63 tui-startup-locale.ts 39
tui-stderr.ts 72              tui-submit-metadata.ts 20
tui-workspace-git.ts 92       tui-workspace-paths.ts 134
```

**为什么值得做**：Rust 侧 `crates/tui` 已经是干净的两层（`presentation*` 纯渲染 /
`client`+`transport` 传输 / `editor`+`picker`+`selector` 输入），而 TS 侧把 TUI 的启动、
locale、stderr、workspace 路径都留在 `cli` 包里。两侧职责划分不一致，继续对齐时会反复绕。

### P2-A：400 行规则的两个真实缺口（本仓可做）

`max-lines` 在 `.oxlintrc.json` 声明为 `error`、`max: 400`、`skipBlankLines`/`skipComments`，
且只对 test/spec 与 `i18n/locales/*.ts` 豁免。**规则本身有效**（合成 500 行文件确实报 error），
但有两个缺口：

**缺口一：`ignorePatterns` 含 `apps/zcode-cli`**

```json
"ignorePatterns": ["dist-release", "packages/ui/src/components/ui",
  "packages/ui/src/components/ai-elements", ".agents/skills",
  "packages/formal-proof", "apps/zcode-cli", "docs/electron"]
```

根 `pnpm lint` 因此**完全不覆盖整个 CLI 包**（约 96K 行 TS）。CLI 包靠 turbo 独立跑
`oxlint src`（`apps/zcode-cli/package.json` 的 `lint: turbo run lint`），但 `packages/dynamic-workflow`
层有自己的 `.oxlintrc.json`，各包规则是否一致未见对账。

**缺口二：173 个文件用行内注释豁免**

```
rg -l "eslint-disable max-lines|oxlint-disable max-lines" -g '*.ts' -g '*.tsx' | wc -l
→ 173
```

分布主要在 `packages/services`（bots、zcode-agent、skill-sync、mcp-sync…）、`packages/server`。
部分豁免带理由（例如 `botsService.ts` 首行注明「鉴权、命令路由、ZCode Agent 桥接收口集中在同一服务内」），
但 **173 这个量级已经让 400 行规则名存实亡**。

这两个缺口需要分别决策，不能混为一谈：缺口一是**门禁范围**问题（要不要把 CLI 纳入根 lint），
缺口二是**豁免纪律**问题（173 个豁免是否逐个有理由、是否该定期复核）。

### knip 未进 CI（两边都欠）

报告 §5.2 原文：

> `knip` 检测 unused exports（**当前已配置但未在 CI 执行**）

本仓同样状态：`package.json` 有 `knip` script 与 `knip@^6.0.6` 依赖，`AGENTS.md` 把 `pnpm knip`
列为标准命令，但 `.github/workflows/` 下**没有任何 workflow 调用它**，`verify:pre-push`
（`pnpm run lint && pnpm run architecture:check -- --changed`）也不含。

## 所有者与边界

- **本 spec 只做对账与工单排序，不改变任何运行时行为。** 所有条目的落地各自需要独立 spec。
- 已确认「两边都欠」的项（P0-A / P1-B / P1-D / P1-F / knip）**不以上游为前置条件**，可独立推进。
- P1-D 迁移的 owner 是 `@zcode/cli` 与 `@zcode/tui` 的边界：迁移后 `cli` 只负责参数解析与命令路由，
  TUI 的启动、locale、stderr、workspace 路径归 `@zcode/tui`。这与 `desktop-cli-entry.md` 里
  「Main bootstrap 是公共启动分流唯一所有者」不冲突 —— 那是进程入口层，这是包内职责层。
- P2-A 缺口一涉及 `.oxlintrc.json` 的 `ignorePatterns`，改动前必须确认
  `apps/zcode-cli` 在根 lint 下不会引入大量既有告警；按 `formatting-gate.md` 的先例，
  门禁变更必须同时给出「当前违规计数」与「忽略清单维护规则」。
- 不修改 `apps/zcode-cli-rust`。Rust 侧有自己的 `check-zcode-cli-rust-boundaries.mjs`。

## 建议的推进顺序

| 顺序 | 项          | 理由                                                            | 预估     |
| ---- | ----------- | --------------------------------------------------------------- | -------- |
| 1    | P0-A        | 纯类型迁移，编译器兜底；两边都欠且风险最低                      | 1 个 PR  |
| 2    | knip 进 CI  | 只加一行 workflow；先拿到基线计数，否则后面重构没有 unused 证据 | 1 个 PR  |
| 3    | P2-A 缺口一 | 先量化 `apps/zcode-cli` 纳入根 lint 的告警数，再决定是否纳入    | 1 个 PR  |
| 4    | P1-D        | 与 Rust TUI 的职责划分对齐；本仓已无登录流程，可简化            | 按子域拆 |
| 5    | P1-B        | 依赖 P1-D 完成后再动 `deps.ts`，避免同一批文件改两次            | 按域拆   |
| 6    | P2-A 缺口二 | 173 个豁免逐个复核，工作量大且收益是纪律而非功能                | 持续     |
| —    | P1-C / P1-F | 上游同样欠且无用户可见收益，暂不排期                            | —        |

## 验收

1. 每条目落地时，本 spec 的判定列更新为「已做」并附 commit；不接受「对账过就等于做完」。
2. P0-A：`rg "interface PermissionDecisionResult" apps/zcode-cli/packages` 只命中一处；
   `pnpm typecheck` 通过；相关 permission 测试通过。
3. knip 进 CI：workflow 里有 `pnpm knip`，且失败会阻断；首次运行记录基线计数。
4. P2-A 缺口一：给出「纳入前 / 纳入后」的 error 数与 warning 数；若纳入会产生大量既有告警，
   则改为按目录分批纳入，并在 spec 里记录批次。
5. P1-D：`apps/zcode-cli/packages/cli/src/tui-*.ts` 归零；`@zcode/tui` 承担启动、locale、
   stderr、workspace 路径；CLI 包的 lint/typecheck/测试通过；Rust TUI 的两层划分保持不变。
6. 每次落地后跑 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`，如实记录。

## 本轮已执行

只读对账，未修改任何源码：

- `git show upstream/main:...docs/code-review-report.md`（报告全文与 §4/§5）
- 类型重复：`rg -n "interface PermissionDecisionResult|ToolScheduleItem"`（两侧）
- `deps.ts` 引用面：`rg -l 'from "\.\./deps\.js"' → 131`
- `tui-*` 计数：上游 15 / 本仓 14，并逐文件比出差异
- bootstrap 巨型文件：本仓 5603 / 4007 / 3463，上游 5870 / 4132 / 3494（**非本仓回归**）
- `max-lines` 有效性：合成 500 行文件报 error（规则有效）；`botsService.ts`（5939 非空非注释行）
  0 error，因首行 `eslint-disable max-lines` 带理由豁免
- 豁免面：`rg -l "eslint-disable max-lines|oxlint-disable max-lines"` → **173**
- `ignorePatterns` 含 `apps/zcode-cli`（根 lint 不覆盖 CLI 包）
- `knip`：`package.json` 有 script 与依赖，`.github/workflows/` 无调用

未执行 `pnpm knip`（会全仓扫描，耗时且不在本次范围）；未修改 `.oxlintrc.json`；
未触碰 `apps/zcode-cli-rust`、`packages/ui` 与用户数据。
