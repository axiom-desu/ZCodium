# 上游 code review 报告的落地对账

上游在 `apps/zcode-cli/docs/code-review-report.md` 留了一份 628 行的自审报告（审查日期
**2026-06-04**，随 v3.15.1 于 **2026-10-10** 公开）。本 spec 把报告里的 P0/P1/P2 与工程化建议
逐项对到当前 checkout，标出「两边都已做」「两边都欠」「只有我们欠」，作为后续重构的工单。

结论先行：**报告点名的多数项，上游和本仓都没做。** 真正落地确认的只有 `modelAdapter?: any`
（P0-B）与 tui 不再依赖 core（P1-E），加上本仓自己补的 P0-A（重复类型）与 knip 门禁。
**最关键的一项 —— 拆 AgentRuntime God Object（P1-A）—— 两仓都原样付着装。** 所以这不是我们落后于上游，
是一份双方共有的欠账（但也意味着：这些欠账不以上游为前置条件，可以自己推）。

> 上一版本文曾把 P1-A 记为「已做」，依据是 `core/src/runtime.ts` 只有 39 行。那是误判：
> 该文件只是 re-export barrel，真正的 God Object 在 `core/src/runtime/methods/`（100 文件 /
> 25891 行）、`runtime/agent-runtime.ts`（655 行）与 `runtime/internal.ts`（147 行）里。
> 核对数据见「[P1-A 现状](#p1-a-现状为什么上一版误判为已做)」。

## 基准与复现

- 上游基准：`upstream/main` = `aac47556`（2026-10-10，`feat: update to v3.15.1`），本地已 fetch。
- 本仓基准：`main`。
- 复现命令全部是只读 git/ripgrep，不联网：

```bash
git show upstream/main:apps/zcode-cli/docs/code-review-report.md | sed -n '/^## 4\./,/^## 6\./p'
rg -n "interface PermissionDecisionResult" apps/zcode-cli/packages/
ls apps/zcode-cli/packages/cli/src/tui-*.ts
```

## 逐项对账

| 编号 | 报告项                                | 上游现状                            | 本仓现状                                                   | 判定         |
| ---- | ------------------------------------- | ----------------------------------- | ---------------------------------------------------------- | ------------ |
| P0-A | 统一重复类型定义                      | ❌ 仍未（4 字段版仍在）             | ✅ 已做（三处定义收敛为两处）                              | **本仓领先** |
| P0-B | 修复 `modelAdapter?: any`             | ✅ 已修                             | ✅ 已修                                                    | 都做了       |
| P0-C | contracts 中的业务逻辑函数移出        | 🟡 部分                             | 🟡 `compact`/`rewind` 仍在（无 `memory`）                  | 待核         |
| P1-A | 拆分 AgentRuntime God Object          | ❌ 106 文件 / 27219 行              | ❌ 100 文件 / 25891 行                                     | **两边都欠** |
| P1-B | 消除 `deps.ts` 集中重导出             | ❌ 仍有                             | ❌ 有，321 行，**131 个文件**引用它                        | **两边都欠** |
| P1-C | 拆分 bootstrap 中的子系统             | ❌ 上游同名文件更大                 | ❌ 同上                                                    | 上游也欠     |
| P1-D | 将 cli 包中 `tui-*` 移入 tui 包       | ❌ **15 个**                        | ❌ **14 个**                                               | **两边都欠** |
| P1-E | TUI 不直接依赖 core                   | ✅ 已修                             | ✅ 已修（无 `@zcode/core`）                                | 都做了       |
| P1-F | 合并 shared-types 到 contracts        | ❌ 仍有                             | ❌ 52 行空壳                                               | 两边都欠     |
| P2-A | 超 400 行文件拆分                     | —                                   | ⚠️ 规则启用但门禁有洞（见下）                              | **本仓可做** |
| P2-E | 拆分 cli 单测文件                     | ❌ `cli.unit.test.ts` 6539 行       | ⚠️ 无该文件，因测试被大幅删除                              | 不适用       |
| §5.2 | `max-lines` lint                      | 仅建议                              | ✅ 已启用                                                  | **本仓领先** |
| §5.2 | boundaries lint（tui 不 import core） | 仅建议                              | ⚠️ **未覆盖**（policy 里 `zcode-cli` 是 `managed: false`） | 两边都欠     |
| §5.2 | **knip 进 CI**                        | ❌ 报告自述「已配置但未在 CI 执行」 | ✅ 已进（棘轮基线 1141 条）                                | **本仓领先** |

### P0-A：两份重复类型（本轮处理）

`PermissionDecisionResult` 存在两份且**字段数不同**：

| 位置                                | 字段数 | 内容                                                                                                                |
| ----------------------------------- | -----: | ------------------------------------------------------------------------------------------------------------------- |
| `core/src/permission/service.ts:64` |     10 | `decision`/`allowed`/`reason`/`modifiedInput`/`escalated`/`mode`/`ruleId`/`riskLevel`/`sideEffectScope`/`alwaysAsk` |
| `core/src/runtime/types.ts:684`     |      4 | `allowed`/`reason`/`modifiedInput`/`permissionUpdates`                                                              |

`ToolScheduleItem` 同样两份：`core/src/tool/scheduler.ts:18`（8 字段）与
`core/src/agent/turn-state.ts:126`（3 字段，是前者的严格子集）。上游现状完全一致。

**报告把两者都叫作「重复」，但实测关系不同：**

- `ToolScheduleItem` 是真重复：turn-state 版是 scheduler 版的丢失投影，没有独有字段。
- `PermissionDecisionResult` 不是 `permission/service.ts` 的重复，而是 `@zcode/contracts` 的
  `PermissionBrokerResult` 的**简化投影**：它独有的 `allowed: boolean` 与 `permissionUpdates`
  说明它描述的是「broker 应答」，不是「策略求值结果」（后者要求调用方提供 `mode`/`ruleId`/
  `riskLevel`/`escalated`）。两份定义唯一的交集是 `reason`/`modifiedInput`。

因此迁移方向不是报告写的「统一移到 contracts」，而是：

| 类型                       | 权威定义                                       | 动作                                                     |
| -------------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| `PermissionDecisionResult` | `@zcode/contracts` 的 `PermissionBrokerResult` | 删 core 本地版本，3 个 runtime 消费方改用 contracts 类型 |
| `ToolScheduleItem`         | `core/src/tool/scheduler.ts`                   | 删 `turn-state.ts` 本地版本，改为 import                 |

依据：两者都**没有任何跨包消费方**（全仓仅 core 内引用；`core/src/index.ts:19` 已导出 scheduler 版，
`:126` 导出的 `PermissionDecisionResult` 来自 `permission/service.ts`），所以在 core 内收敛即可，
不需往 contracts 新增定义。

**顺带修掉一个真实缺陷：** `runtime/methods/tools.ts:273` 的 `resolvePermission` 把简化版应答
用 `decision.allowed ? "allow" : "deny"` 压平后再转成 broker 结果，`escalate`/`modify` 会被抹成
`allow`。该函数当前**全仓零调用**（`rg "\.resolvePermission\("` 只命中 broker 自己的同名方法），
所以改动不改变任何运行时行为，只是删除这条错误转换。

**本轮不做（已知但超出本项范围）：**

- `core/src/agent/turn-state.ts` 还自带一份 `PermissionDecision = "allow" | "deny" | "escalate" | "modify"`，
  与 `contracts/src/events/session.events.ts` 的同名类型重复 —— 这是第三个重复类型，报告未列入。
- `ToolScheduleState`（turn-state.ts）与 `ToolSchedule`（scheduler.ts）结构完全相同，同样可收成一个。
- `toScheduleState` 仍然只搬 3/8 个字段（`resume.ts:44`）；扩成全字段会改变 TurnState 内容，需单独验证。

#### 验收（P0-A）

- `rg "interface PermissionDecisionResult|interface ToolScheduleItem" apps/zcode-cli/packages`
  分别只命中 `permission/service.ts` 与 `tool/scheduler.ts`；
- `pnpm typecheck` 通过；`pnpm lint` 无新增；`pnpm architecture:check --changed` 0 violations；
- `pnpm knip:check` 为 OK（基线中 `runtime.ts\0PermissionDecisionResult` 那条会消失，属「已消除」
  而非新增；需同步收紧基线）。

#### 落地结果（P0-A）

7 个文件，净删除 14 行（无新增行为）：

| 文件                                        | 改动                                                                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `core/src/runtime/types.ts`                 | 删 4 字段 `PermissionDecisionResult`；`PermissionUpdate` 导入随之孤作化，已移除                                             |
| `core/src/runtime/methods/tools.ts`         | `resolvePermission` 参数改用 `PermissionBrokerResult`；删掉 `allowed ? "allow" : "deny"` 压平（会抹掉 `escalate`/`modify`） |
| `core/src/runtime/agent-runtime.ts`         | 接口声明同步，import 从 `./types.js` 改为 `./deps.js`                                                                       |
| `core/src/runtime/internal-turn-methods.ts` | 同上                                                                                                                        |
| `core/src/runtime.ts`                       | 从 barrel 的 re-export 列表移除（knip 之前已标它为未用导出）                                                                |
| `core/src/agent/turn-state.ts`              | 删 3 字段 `ToolScheduleItem`，改为从 `../tool/scheduler.js` 导入                                                            |
| `core/src/runtime/deps.ts`                  | 删随之孤作化的 `PermissionUpdate` 重导出行                                                                                  |

验证（均为实测）：

- `rg "interface PermissionDecisionResult|interface ToolScheduleItem" apps/zcode-cli/packages` →
  只剩 `permission/service.ts:64` 与 `tool/scheduler.ts:18`；
- `cd apps/zcode-cli/packages/core && npx tsc --noEmit` → exit 0（**必须单独跑**：仓库根的
  `pnpm typecheck` 不包含 `apps/zcode-cli`，见下节）；
- `pnpm lint` → 50 warnings / 0 errors（与改动前一致）；
- `pnpm knip:check` → `knip: OK`，基线从 1142 收紧到 **1141**（两次改变：`runtime.ts\0PermissionDecisionResult`
  被 resolved，以及 `deps.ts\0PermissionUpdate` 从未进基线所以只表现为 `new` 归零）；
- `pnpm architecture:check --changed` → 0 violations；
- 改动的两个超 400 行文件行数与 HEAD 完全一致（655 / 437），未引入新超行。

遗留（已在本节「本轮不做」列出）：`ToolScheduleState` vs `ToolSchedule` 仍是结构相同的两份；
`toScheduleState` 仍只搬 3/8 个字段；`turn-state.ts` 的 `PermissionDecision` 与 contracts 重复。

### 门禁覆盖实测：`apps/zcode-cli` 在三个根级门禁里都是盲区

这是写 P0-A 时顺带量出来的，比报告 §5.2 的描述更具体：

| 根级门禁                     | 是否覆盖 `apps/zcode-cli` | 证据                                                                                                                                                                                             |
| ---------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm lint`（oxlint）        | ❌ 不覆盖                 | `.oxlintrc.json` 的 `ignorePatterns` 含 `apps/zcode-cli`                                                                                                                                         |
| `pnpm fmt:check`（oxfmt）    | ❌ 不覆盖                 | 从根执行 `npx oxfmt --check apps/zcode-cli/packages/core/src` → `Expected at least one target file`；对 `packages/services/src` 则正常扫 284 文件。CLI 下有自己的 `apps/zcode-cli/.oxfmtrc.json` |
| `pnpm typecheck`（`tsc -b`） | ❌ 不覆盖                 | 根 script 的 project 列表里没有任何 `apps/zcode-cli/*`                                                                                                                                           |

`apps/zcode-cli` 自己有 `lint: turbo run lint`、`format:check`、`typecheck` 三个脚本，
**CI 一个都不调**。其中类型检查只是被间接覆盖（CI 的 `pnpm -r --filter './apps/zcode-cli/packages/*' build`
走 `tsc` 发码，类型错误会失败）；**lint 与格式则完全没进门禁**。

实测 CLI 自身的 lint 现在是**红的**：`cd apps/zcode-cli && npx turbo run lint` → 14 个任务里
`@zcode/cli`、`@zcode/bootstrap`、`@zcode/tui` 失败；仅 `@zcode/core` 一个包就有 30 条
`max-lines` error。也就是说「把 CLI 纳入根 lint」不是一个开关，而是一次性清 30+ 条存量告警的工程。

**这也解释了为什么 P2-A（400 行）在 core 里形同虚设**：规则本身生效，但检查它的那个命令没人跑。

### P1-B：`deps.ts` 是当前最重的耦合点

`apps/zcode-cli/packages/core/src/runtime/deps.ts` 321 行，被 **131 个文件**引用。报告原文：

> 每个 methods 文件将 `import { ... } from "../deps.js"` 改为直接从 `@zcode/contracts` 导入

它与 P1-A 是同一件事的两面，**但 P1-A 并没有完成**（见下节），所以 `deps.ts` 不是「拆完 God Object
后遗留的副产品」，而是 God Object 的配套结构：131 个文件都通过它拿到同一个巨型依赖集合。

**本仓的特殊性**：Rust 侧已把端口与实现分到不同 crate（`crates/core-api` 与 `crates/core`），
TS 侧却在 `core/src/runtime/deps.ts` 里把所有依赖汇成一个 321 行的重导出。两侧的边界标准不一致，
继续对齐时会变成摩擦。

### P1-A 现状（为什么上一版误判为已做）

上一版把「`core/src/runtime.ts` 只有 39 行」当成 God Object 已拆的证据。实际上该文件只是 re-export
barrel（把 `AgentRuntime` 与一堆类型重新导出），真正的东西在它下面：

| 指标                                                     |      本仓 |      上游 | 说明                             |
| -------------------------------------------------------- | --------: | --------: | -------------------------------- |
| `core/src/runtime/methods/` 文件数                       |   **100** |   **106** | 报告的「30+ 方法文件」，实际更多 |
| `core/src/runtime/methods/` 总行数                       | **25891** | **27219** | —                                |
| 使用 `this: AgentRuntimeInternal`                        |    **59** |    **61** | 报告称之为「假拆分」             |
| `runtime/agent-runtime.ts` 行数                          |   **655** |   **720** | God Object 主体                  |
| `runtime/internal.ts`（巨型内部接口）                    |   **147** |   **169** | `AgentRuntimeInternal` 定义于此  |
| `core/src/runtime.ts`（barrel）                          |        39 |        40 | 仅 re-export，不是拆分证据       |
| `PersistenceService`/`CompactManager`/`TurnOrchestrator` |    不存在 |    不存在 | 报告 P1-A 的 3 个目标服务        |

**结论：报告 P1-A 的 5 个 Phase 一个都没落地，上游也没有。** 判定应为「两边都欠」，不是「都做了」。
复现：

```bash
ls apps/zcode-cli/packages/core/src/runtime/methods/*.ts | wc -l
rg -l "this: AgentRuntimeInternal" apps/zcode-cli/packages/core/src | wc -l
wc -l apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts apps/zcode-cli/packages/core/src/runtime/internal.ts
```

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

根 `pnpm lint` 因此**完全不覆盖整个 CLI 包**（`apps/zcode-cli/packages` 共 296K 行 TS）。CLI 包靠 turbo 独立跑
`oxlint src`（`apps/zcode-cli/package.json` 的 `lint: turbo run lint`），但 `packages/dynamic-workflow`
层有自己的 `.oxlintrc.json`，各包规则是否一致未见对账。

**缺口二：173 个文件用行内注释豁免**

```
rg -l "eslint-disable max-lines|oxlint-disable max-lines" -g '*.ts' -g '*.tsx' | wc -l
→ 173
```

分布（按目录，共 173）：`packages/ui/src` 87、`packages/services/src` 29、`packages/desktop/src` 24、
`packages/shared/src` 11、`core/src` 8、`packages/web/src` 3、`packages/server/src` 3。
**一半以上在 UI 包**，而不是原报告关心的 core。
部分豁免带理由（例如 `botsService.ts` 首行注明「鉴权、命令路由、ZCode Agent 桥接收口集中在同一服务内」），
但 **173 这个量级已经让 400 行规则名存实亡**。

这两个缺口需要分别决策，不能混为一谈：缺口一是**门禁范围**问题（要不要把 CLI 纳入根 lint），
缺口二是**豁免纪律**问题（173 个豁免是否逐个有理由、是否该定期复核）。

### knip 已进 CI（棘轮，2026-10-20）

报告 §5.2 原文：

> `knip` 检测 unused exports（**当前已配置但未在 CI 执行**）

本仓此前同样状态：`package.json` 有 `knip` script 与 `knip@^6.0.6` 依赖，`AGENTS.md` 把 `pnpm knip`
列为标准命令，但 `.github/workflows/` 下没有调用，`verify:pre-push` 也不含。

**现在：** `scripts/ci/knip-ratchet.mjs` + `.knip-baseline.json`，CI 的 `checks` job 在 `Architecture`
之后跑 `pnpm knip:check`，失败即阻断。

**为什么不直接跑 `pnpm knip`：** 首次实测 1142 条既有告警（未用导出 510、未用类型 283、未用文件 161、
未声明依赖 92、未用依赖 51、重复导出 37、未用 devDependencies 32、未用二进制 1）。
一次性清零不现实，直接当门禁只会立刻变红然后被 `continue-on-error` 绕过 —— 那正好是报告批评的形态。

**棘轮设计**（与 `scripts/architecture/architecture-check.mjs` 的 `.architecture-baseline.json` 同构）：

| 决策     | 取值                                              | 理由                                                                |
| -------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| 指纹     | `分类\0文件\0符号名`                              | 不含行列号；代码上下移动不产生基线抖动                              |
| 判定     | 只对**新增**失败                                  | 允许逐步减少，不需要一次性清零                                      |
| 基线     | `.knip-baseline.json`（只存指纹字串，按指纹排序） | 顺序无关；不重存 kind/file/name，避免字段与指纹漂移（115K vs 299K） |
| 收紧     | `pnpm knip:baseline`                              | 消除告警后手动收紧，避免基线虚高                                    |
| 配置建议 | `--no-config-hints` 排除                          | 17 条 entry/project 提示属配置整理建议，不是死代码                  |

**两个已排除的坑（都是实测踩到的）：**

1. **不能走 `pnpm exec knip`。** pnpm 会把 engine 提示写到 stdout
   （`apps/zcode-cli | WARN Unsupported engine...`），JSON 报告被污染成无法解析的文本，
   门禁会随 node/pnpm 版本随机失败。改为 `require.resolve("knip")` 定位包入口再回推
   `bin/knip.js`，用 `process.execPath` 直接启动。注意 knip 的 `exports` 字段不允许直接解析
   `knip/bin/knip.js`（`ERR_PACKAGE_PATH_NOT_EXPORTED`）。
2. **knip 的 `issues` 数组顺序不稳定。** 同一份代码连跑两次，`issues` 条目顺序不同（内容一致）。
   因此判定走指纹集合而非文本 diff；实测两次运行指纹集合完全相同（1142 = 1142，差集为 0）。

**已验证：** 新增一个未用文件后 `knip:check` 输出 `knip: FAILED` / `new: 1` 并 exit 1，删除后恢复 `OK`。
基线首次生成 1142 条 / 115K，P0-A 后收紧到 **1141 条**（若同时存 kind/file/name 则为 299K，
且多三个会与指纹漂移的字段）。

**已知风险（未在 CI 实机验证）：** 基线在本机（linux x64 / node 24.19.0）生成，CI 是
ubuntu-24.04 x64 + mise 锁定的 node。knip 只分析源码、不执行代码，且 `dist`/`node_modules`
不会进入指纹（实测 0 条），预期一致；但若首次 CI 运行报基线漂移，**按 CI 上的产物重新生成基线
并在此记录差异原因**，不得用 `continue-on-error` 绕过。

## 所有者与边界

- **本 spec 只做对账与工单排序，不改变任何运行时行为。** 所有条目的落地各自需要独立 spec。
- 已确认「两边都欠」的项（P0-A / P1-B / P1-D / P1-F）**不以上游为前置条件**，可独立推进。
- P1-D 迁移的 owner 是 `@zcode/cli` 与 `@zcode/tui` 的边界：迁移后 `cli` 只负责参数解析与命令路由，
  TUI 的启动、locale、stderr、workspace 路径归 `@zcode/tui`。这与 `desktop-cli-entry.md` 里
  「Main bootstrap 是公共启动分流唯一所有者」不冲突 —— 那是进程入口层，这是包内职责层。
- P2-A 缺口一涉及 `.oxlintrc.json` 的 `ignorePatterns`，改动前必须确认
  `apps/zcode-cli` 在根 lint 下不会引入大量既有告警；按 `formatting-gate.md` 的先例，
  门禁变更必须同时给出「当前违规计数」与「忽略清单维护规则」。
- 不修改 `apps/zcode-cli-rust`。Rust 侧有自己的 `check-zcode-cli-rust-boundaries.mjs`。

## 建议的推进顺序

| 顺序 | 项           | 理由                                                                                | 预估     | 状态     |
| ---- | ------------ | ----------------------------------------------------------------------------------- | -------- | -------- |
| 1    | P0-A         | 纯类型迁移，编译器兜底；上游仍欠所以本仓现在领先                                    | 1 个 PR  | **已做** |
| 2    | knip 进 CI   | 先拿到基线计数，否则后面重构没有 unused 证据                                        | 1 个 PR  | **已做** |
| 3    | CLI 门禁覆盖 | 现状是 lint/格式/typecheck 三个根门禁都绕过 `apps/zcode-cli`，而 CLI 自身 lint 已红 | 1 个 PR  | 待做     |
| 4    | P2-A 缺口二  | 173 个豁免逐个复核；已实测一半在 `packages/ui`                                      | 持续     | 待做     |
| 4    | P1-D         | 与 Rust TUI 的职责划分对齐；本仓已无登录流程，可简化                                | 按子域拆 | 待做     |
| 5    | P1-B         | 依赖 P1-D 完成后再动 `deps.ts`，避免同一批文件改两次                                | 按域拆   | 待做     |
| 6    | P2-A 缺口二  | 173 个豁免逐个复核，工作量大且收益是纪律而非功能                                    | 持续     | 待做     |
| —    | P1-C / P1-F  | 上游同样欠且无用户可见收益，暂不排期                                                | —        | 暂缓     |

## 验收

1. 每条目落地时，本 spec 的判定列更新为「已做」并附 commit；不接受「对账过就等于做完」。
2. P0-A：`rg "interface PermissionDecisionResult" apps/zcode-cli/packages` 只命中一处；
   `pnpm typecheck` 通过；相关 permission 测试通过。
3. knip 进 CI：✅ **已完成** — workflow 的 `checks` job 有 `pnpm knip:check`，退出码非 0 即阻断；
   基线 1141 条（首次 1142，P0-A 后收紧）记录在 `.knip-baseline.json`；新增告警实测会失败（见上节「已验证」）。
4. P2-A 缺口一：给出「纳入前 / 纳入后」的 error 数与 warning 数；若纳入会产生大量既有告警，
   则改为按目录分批纳入，并在 spec 里记录批次。
5. P1-D：`apps/zcode-cli/packages/cli/src/tui-*.ts` 归零；`@zcode/tui` 承担启动、locale、
   stderr、workspace 路径；CLI 包的 lint/typecheck/测试通过；Rust TUI 的两层划分保持不变。
6. 每次落地后跑 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`，如实记录。

## 本轮已执行

分两轮：第一轮只读对账，第二轮实施 P0-A 与 knip 门禁。

**只读对账（第一轮）**：

- `git show upstream/main:...docs/code-review-report.md`（报告全文与 §4/§5）
- 类型重复：`rg -n "interface PermissionDecisionResult|ToolScheduleItem"`（两侧）
- `deps.ts` 引用面：`rg -l 'from "\.\./deps\.js"'` → 131
- P1-A 实测：`runtime/methods/` 本仓 100 文件 / 25891 行、上游 106 / 27219；`this: AgentRuntimeInternal`
  本仓 59 / 上游 61；`agent-runtime.ts` 655 / 720 行
- `tui-*` 计数：上游 15 / 本仓 14，并逐文件比出差异
- bootstrap 巨型文件：本仓 5603 / 4007 / 3463，上游 5870 / 4132 / 3494（**非本仓回归**）
- `max-lines` 有效性：合成 500 行文件报 error（规则有效）；`botsService.ts`（5937 非空非注释行）
  0 error，因首行 `eslint-disable max-lines` 带理由豁免
- 豁免面：`rg -l "eslint-disable max-lines|oxlint-disable max-lines"` → **173**，其中 `packages/ui/src` 87
- 根级三个门禁对 `apps/zcode-cli` 的覆盖：全部不覆盖（oxfmt 用对照实验确认）
- CLI 自身 lint 实测：`turbo run lint` 14 个任务，`@zcode/cli`/`@zcode/bootstrap`/`@zcode/tui` 失败；
  `@zcode/core` 单独 30 条 `max-lines` error

**实施（第二轮）**：

- knip 门禁：`scripts/ci/knip-ratchet.mjs` + `.knip-baseline.json`（1141 条）+ CI step + 11 个单测
- P0-A：7 个文件收敛重复类型（见「落地结果（P0-A）」）

未修改 `.oxlintrc.json`、未触碰 `apps/zcode-cli-rust` / `packages/ui` 与用户数据。
`apps/zcode-cli` 的超 400 行存量告警（30 条）未清理——那是「CLI 门禁覆盖」这一项的输入。
