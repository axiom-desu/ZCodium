# 上游 code review 报告的落地对账

上游在 `apps/zcode-cli/docs/code-review-report.md` 留了一份 628 行的自审报告（审查日期
**2026-06-04**，随 v3.15.1 于 **2026-10-10** 公开）。本 spec 把报告里的 P0/P1/P2 与工程化建议
逐项对到当前 checkout，标出「两边都已做」「两边都欠」「只有我们欠」，作为后续重构的工单。

结论先行：表内 14 项对账中，**6 项两边都欠**、2 项两边都做（P0-B、P1-E）、3 项本仓领先
（P0-A、`max-lines`、knip 进 CI），其余为待核/可做/不适用。本仓补上的是 P0-A（重复类型）与
三个棘轮门禁（knip / lint / format）。
**最关键的一项 —— 拆 AgentRuntime God Object（P1-A）—— 两仓都还欠着**（本仓 100 文件 /
25891 行，上游 106 / 27219，见「[P1-A 现状](#p1-a-现状god-object-仍未拆)」）。
这些欠账不以上游为前置条件，可以自己推。

## 本 spec 依据的 commit 索引（`origin/main..HEAD`，ahead 5）

| commit     | 内容                                                                                                                                     | 对本 spec 的影响                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `1b1b7420` | `docs(spec)`：建立本对账（只读，无代码改动）                                                                                             | 初版判定与量测                                      |
| `41bdb3a3` | `feat(ci)`：knip 进 CI（`scripts/ci/knip-ratchet.mjs` + `.knip-baseline.json`）                                                          | 当时基线 1142 条；旧脚本/旧基线已在 `e367c42f` 删除 |
| `da7185d1` | `refactor(core)`：P0-A 收敛两份重复类型                                                                                                  | 判定列 P0-A 改「已做」                              |
| `e367c42f` | `feat(ci)`：单棘轮引擎 + 无 IO 纯解析层（`gate-ratchet.mjs` / `gate-ratchet-core.mjs`）+ 三个适配器，纳入 CLI lint，lint/format 基线入库 | 门禁语义改由 `quality-gates.md` 拥有                |
| `e00ed2f8` | `chore(zcode-cua)`：官方 CUA 帧契约改为休眠并锁死恒否语义                                                                                | **仅索引**：不在 TS 治理/门禁范围内，无门禁影响     |

`e00ed2f8` 只清理 CUA 帧契约占位并加测试，未触碰 `.gate-baseline/`、lint 配置或本 spec 的对账项。
本轮文档收尾只改本文件与 `quality-gates.md`（未提交）：不新增源码、不刷新基线，也未运行远端 CI。

> 状态约定：本文中的「实测」若带 commit/日期，属**历史量测**；「当前」指 `e00ed2f8` 的 checkout。
> 门禁判定、退出码与基线校验的唯一所有者是 `quality-gates.md`，本文只保留对账结论。

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
| P2-A | 超 400 行文件拆分                     | —                                   | ✅ 规则生效且已入 lint 棘轮；⚠️ 对已超限文件继续增长不敏感 | **本仓可做** |
| P2-E | 拆分 cli 单测文件                     | ❌ `cli.unit.test.ts` 6539 行       | ⚠️ 无该文件，因测试被大幅删除                              | 不适用       |
| §5.2 | `max-lines` lint                      | 仅建议                              | ✅ 已启用并进 CI（86 条 error 入基线）                     | **本仓领先** |
| §5.2 | boundaries lint（tui 不 import core） | 仅建议                              | ⚠️ **未覆盖**（policy 里 `zcode-cli` 是 `managed: false`） | 两边都欠     |
| §5.2 | **knip 进 CI**                        | ❌ 报告自述「已配置但未在 CI 执行」 | ✅ 已进（单引擎 + 无 IO 纯解析层，棘轮基线 1141 条）       | **本仓领先** |

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
- `pnpm gate:knip` 为 OK（基线中 `runtime.ts\0PermissionDecisionResult` 那条会消失，属「已消除」
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
- `pnpm lint` → 50 warnings / 0 errors（**历史量测，`da7185d1` 当时**：根 lint 尚未覆盖 `apps/zcode-cli`。
  当前原始真值为 231 条诊断 / 86 error / 145 warning、4318 个文件，exit 1 属预期；`gate:lint` 180 entries 为 OK）；
- `pnpm gate:knip` → `knip: OK`，基线从 1142 收紧到 **1141**（两次改变：`runtime.ts\0PermissionDecisionResult`
  被 resolved，以及 `deps.ts\0PermissionUpdate` 从未进基线所以只表现为 `new` 归零）；
- `pnpm architecture:check --changed` → 0 violations；
- 改动的两个超 400 行文件行数与 HEAD 完全一致（655 / 437），未引入新超行。

遗留（已在本节「本轮不做」列出）：`ToolScheduleState` vs `ToolSchedule` 仍是结构相同的两份；
`toScheduleState` 仍只搬 3/8 个字段；`turn-state.ts` 的 `PermissionDecision` 与 contracts 重复。

### 门禁覆盖：历史量测与当前状态

**历史量测（写 P0-A 时，`da7185d1`）**：三个根级门禁都绕过 `apps/zcode-cli` ——
`pnpm lint` 的 `.oxlintrc.json` 的 `ignorePatterns` 含 `apps/zcode-cli`；
`pnpm fmt:check` 被 `.prettierignore` 排除；`pnpm typecheck` 的 project 列表不含 CLI。
其中类型检查只是被间接覆盖（CI 的 `pnpm -r --filter './apps/zcode-cli/packages/*' build`
走 `tsc` 发码）；lint 与格式完全没进门禁。当时 CLI 自身 `turbo run lint` 14 个任务里
`@zcode/cli`、`@zcode/bootstrap`、`@zcode/tui` 失败，`@zcode/core` 单包 30 条 `max-lines` error。

**当前（`e367c42f` 之后，本地实测）**：

| 根级门禁                       | 是否覆盖 `apps/zcode-cli` | 当前证据                                                                                                                       |
| ------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm lint` / `gate:lint`      | ✅ 覆盖                   | `.oxlintrc.json` 的 `ignorePatterns` 已移除 `apps/zcode-cli`；扫描 4318 个文件，180 keys 中 145 个来自 CLI，86 条 error 入基线 |
| `pnpm fmt:check`/`gate:format` | ❌ 仍排除                 | **有意为之的版本边界**：CLI 自带更高版本 oxfmt，跨目录改写会互相推翻，见 `formatting-gate.md`；不是遗漏，本 spec 不要求打开    |
| `pnpm typecheck`（`tsc -b`）   | ❌ 仍不含                 | 根 project 列表无 CLI；类型由 CI 的 agent build 间接覆盖。**本 spec 不要求强行纳入**（会与 CLI 自身 tsc 重复）                 |

CLI 自身 lint 仍是红的（86 条 `max-lines` error），但已由 lint 棘轮承接：这是「存量债务入基线」，
不是假绿，也不是覆盖已经清零。截至 `e367c42f` 没有修改 `.prettierignore` 与根 typecheck project 列表。
**本次只关闭根 lint 盲区**；format 与 typecheck 的盲区仍保留（前者是版本边界，后者由 CI 的
agent build 间接覆盖），属有意接受，不是遗漏。`verify:pre-push` 只跑 lint + format + architecture，
不含 knip；CI 的 `checks` job 才跑三个 gate。

**P2-A 的结论要改写**：400 行规则不再「没人跑」，但棘轮对已超限文件继续增长不敏感（见下节缺口三），
所以只能说「已纳入门禁」，不能说「400 行已被完整执行」。

### P1-B：`deps.ts` 是当前最重的耦合点

`apps/zcode-cli/packages/core/src/runtime/deps.ts` 321 行，被 **131 个文件**引用。报告原文：

> 每个 methods 文件将 `import { ... } from "../deps.js"` 改为直接从 `@zcode/contracts` 导入

它与 P1-A 是同一件事的两面，**但 P1-A 并没有完成**（见下节），所以 `deps.ts` 不是「拆完 God Object
后遗留的副产品」，而是 God Object 的配套结构：131 个文件都通过它拿到同一个巨型依赖集合。

**本仓的特殊性**：Rust 侧已把端口与实现分到不同 crate（`crates/core-api` 与 `crates/core`），
TS 侧却在 `core/src/runtime/deps.ts` 里把所有依赖汇成一个 321 行的重导出。两侧的边界标准不一致，
继续对齐时会变成摩擦。

### P1-A 现状：God Object 仍未拆

`core/src/runtime.ts` 只有 39 行，但它只是 re-export barrel（把 `AgentRuntime` 与一堆类型重新导出），
不能当作已拆分的证据；真正的东西在它下面：

| 指标                                                     |      本仓 |      上游 | 说明                             |
| -------------------------------------------------------- | --------: | --------: | -------------------------------- |
| `core/src/runtime/methods/` 文件数                       |   **100** |   **106** | 报告的「30+ 方法文件」，实际更多 |
| `core/src/runtime/methods/` 总行数                       | **25891** | **27219** | —                                |
| 使用 `this: AgentRuntimeInternal`                        |    **59** |    **61** | 报告称之为「假拆分」             |
| `runtime/agent-runtime.ts` 行数                          |   **655** |   **720** | God Object 主体                  |
| `runtime/internal.ts`（巨型内部接口）                    |   **147** |   **169** | `AgentRuntimeInternal` 定义于此  |
| `core/src/runtime.ts`（barrel）                          |        39 |        40 | 仅 re-export，不是拆分证据       |
| `PersistenceService`/`CompactManager`/`TurnOrchestrator` |    不存在 |    不存在 | 报告 P1-A 的 3 个目标服务        |

**结论：报告 P1-A 的目标服务（`PersistenceService`/`CompactManager`/`TurnOrchestrator`）两仓都不存在，
`methods/` 仍是本仓 100 文件 / 25891 行、上游 106 / 27219 行。判定为「两边都欠」。**
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

### P2-A：400 行规则的三个缺口（一已修、二待复核、三是棘轮固有）

`max-lines` 在 `.oxlintrc.json` 声明为 `error`、`max: 400`、`skipBlankLines`/`skipComments`，
且只对 test/spec 与 `i18n/locales/*.ts` 豁免。**规则本身有效**（合成 500 行文件确实报 error）。

**缺口一（已修，`e367c42f`）：`ignorePatterns` 含 `apps/zcode-cli`**

历史量测时根 `pnpm lint` 完全不覆盖整个 CLI 包。当前 `.oxlintrc.json` 的 `ignorePatterns` 已无
`apps/zcode-cli`，根 lint 实测扫描 4318 个文件，CLI 的 86 条 `max-lines` error 全部进入 lint 基线。
CLI 包仍有自己的 `lint: turbo run lint`，与根规则的差异未逐包对账（不阻塞门禁）。

**缺口二（待复核）：行内豁免数量级**

```
rg -l "eslint-disable max-lines|oxlint-disable max-lines" -g '*.ts' -g '*.tsx' | wc -l
→ 171（历史量测为 173；`e367c42f` 删除了 2 处已失效的豁免）
```

分布按历史量测（共 173）：`packages/ui/src` 87、`packages/services/src` 29、`packages/desktop/src` 24、
`packages/shared/src` 11、`core/src` 8、`packages/web/src` 3、`packages/server/src` 3。
**一半以上在 UI 包**，而不是原报告关心的 core。部分豁免带理由（例如 `botsService.ts` 首行注明
「鉴权、命令路由、ZCode Agent 桥接收口集中在同一服务内」），但 170+ 的量级仍需要逐个复核。
口径差异：把 `-g '*.mjs'` 也算进来时当前为 176，与只算 ts/tsx 的 171 不是同一集合，引用时必须带口径。

**缺口三（棘轮固有，不能靠门禁解决）：已超限文件继续增长不敏感**

lint 适配器的 key 是 `(severity, code, file)`，`max-lines` 对每个文件只出 1 条诊断。
一个已超 400 行的文件从 500 行涨到 900 行，count 仍是 1，棘轮不报警。因此「`max-lines` 已进 CI」
只覆盖「新增超限文件」，不覆盖「存量继续膨胀」，也不能声称 400 行已被完整执行；超限存量仍需人工拆分。
详见 `quality-gates.md` 的「已知不敏感」。

### knip 已进 CI（2026-10-20 起；`e367c42f` 并入单引擎）

报告 §5.2 原文：

> `knip` 检测 unused exports（**当前已配置但未在 CI 执行**）

本仓此前同样状态：`package.json` 有 `knip` script 与 `knip@^6.0.6` 依赖，`AGENTS.md` 把 `pnpm knip`
列为标准命令，但 `.github/workflows/` 下没有调用，`verify:pre-push` 也不含。

**现在：** `scripts/ci/gate-ratchet.mjs` 的 knip 适配器 + `.gate-baseline/knip.json`（1141 条），
CI 的 `checks` job 在 `Architecture` 之后跑 `pnpm gate:knip`，失败即阻断。`41bdb3a3` 引入的
`pnpm knip:check` / `scripts/ci/knip-ratchet.mjs` / `.knip-baseline.json` 已在 `e367c42f` 删除，
文档与脚本中不得再引用这三个旧名字。

**为什么不直接跑 `pnpm knip`：** 首次实测 1142 条既有告警（`41bdb3a3` 时）。当前分类实测
（2026-10-20）：未用导出 510、未用类型 282、未用文件 161、未声明依赖 92、未用依赖 51、
未用 devDependencies 32、duplicates 12（文件级；原始为 37 组 / 74 成员）、未用二进制 1，
合计 **1141** 条（P0-A 收紧后）。一次性清零不现实，直接当门禁只会立刻变红然后被
`continue-on-error` 绕过 —— 那正好是报告批评的形态。

**棘轮设计**（与 `scripts/architecture/architecture-check.mjs` 的 `.architecture-baseline.json` 同构）：

| 决策     | 取值                                                   | 理由                                                                |
| -------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| 指纹     | `knip\0分类\0文件\0符号名`                             | 不含行列号；代码上下移动不产生基线抖动；首段 gate 便于从基线反解    |
| 判定     | 只对**新增或 count 上升**失败                          | 允许逐步减少，不需要一次性清零                                      |
| 基线     | `.gate-baseline/knip.json`（只存指纹字串，按指纹排序） | 顺序无关；不重存 kind/file/name，避免字段与指纹漂移（115K vs 299K） |
| 收紧     | `pnpm gate:baseline`                                   | 消除告警后手动收紧，避免基线虚高                                    |
| 配置建议 | `--no-config-hints` 排除                               | 17 条 entry/project 提示属配置整理建议，不是死代码                  |

**duplicates 的口径（实测纠正）**：knip 6 的 JSON 把 `duplicates` 输出为「组 → 成员」的嵌套
数组，当前仓库实测 12 个文件 / 37 组 / 74 成员。基线沿用历史形状，按文件折叠成 12 条 `name`
为空的 key，所以 1141 条里 duplicates 只占 12 条（不是 37 条），且**同一文件新增重复组或成员
不会被检出**——只有某个文件第一次出现 duplicates 才会新增 key。此前把原始 37 组当成基线条目、
或声称「新增成员可检出」都与实测不符。本轮保持基线集合不变、不刷新基线，这是**明确接受的
残余限制**，不是已治理项（详见 `quality-gates.md`「已知不敏感」）。

**两个已排除的坑（都是实测踩到的）：**

1. **不能走 `pnpm exec knip`。** pnpm 会把 engine 提示写到 stdout
   （`apps/zcode-cli | WARN Unsupported engine...`），JSON 报告被污染成无法解析的文本，
   门禁会随 node/pnpm 版本随机失败。改为 `require.resolve("knip")` 定位包入口再回推
   `bin/knip.js`，用 `process.execPath` 直接启动。注意 knip 的 `exports` 字段不允许直接解析
   `knip/bin/knip.js`（`ERR_PACKAGE_PATH_NOT_EXPORTED`）。
2. **knip 的 `issues` 数组顺序不稳定。** 同一份代码连跑两次，`issues` 条目顺序不同（内容一致）。
   因此判定走指纹集合而非文本 diff；实测两次运行指纹集合完全相同（1142 = 1142，差集为 0）。

**已验证（本地实测 2026-10-20）：** 集成测试用假工具覆盖「新增未用文件 → FAILED/exit 1、
删除 → OK」、基线缺失/损坏/清零、locale 幂等、入口复制等 14 个场景；单测另 36 个。
当前 `pnpm gate:knip` 实测 1141/1141、exit 0。基线首次生成 1142 条 / 115K，P0-A 后收紧到
**1141 条**（若同时存 kind/file/name 则为 299K，且多三个会与指纹漂移的字段）。
判定细节（count 语义、退出码、基线结构校验、排序）见 `quality-gates.md`。

**已知风险（本地验证，远端 CI 待 PR 后回填）：** 基线在本机（linux x64 / node 24.19.0）生成，
CI 是 ubuntu-24.04 x64 + mise 锁定的 node。knip 只分析源码、不执行代码，且 `dist`/`node_modules`
不会进入指纹（实测 0 条），预期一致；但若远端 CI 报基线漂移，**按 CI 上的产物重新生成基线并在此
记录差异原因**，不得用 `continue-on-error` 绕过。这是 PR 前记录的环境风险，实际首轮 CI 结果见下文。

**首轮远端 CI 实测（PR#85、HEAD `eff88e64`）：** `gate:knip` 报新增 5 个 `types`（1146 vs 1141），
run id `39398035529`，失败。5 个符号是 adapters 的 `McpServerConfigSource` / `PluginConfigScope` /
`PluginConfigSources` / `MarketplaceRefreshFailure` / `PluginValidationDiagnostic`，经全仓
`git grep` 确认无跨文件消费，已收为文件内私有；**基线未刷新、未忽略该项**。本地同 HEAD（含
`CI=true`）仍为 1141，差异原因未确认，不得把「本地 dist」当作已证实原因。首轮 CI 结果为失败；
后续重跑的实际结论回填到 `quality-gates.md` 的「CI 复验记录」，本文不宣称 CI 已通过。

## 所有者与边界

- **本 spec 只做对账与工单排序，不改变任何运行时行为。** 所有条目的落地各自需要独立 spec。
- 已确认「两边都欠」的项（P1-B / P1-C / P1-D / P1-F 与 boundaries 规则）**不以上游为前置条件**，
  可独立推进；P0-A 已由本仓完成（`da7185d1`）。
- P1-D 迁移的 owner 是 `@zcode/cli` 与 `@zcode/tui` 的边界：迁移后 `cli` 只负责参数解析与命令路由，
  TUI 的启动、locale、stderr、workspace 路径归 `@zcode/tui`。这与 `desktop-cli-entry.md` 里
  「Main bootstrap 是公共启动分流唯一所有者」不冲突 —— 那是进程入口层，这是包内职责层。
- P2-A 缺口一已由 `e367c42f` 修完（移除 `apps/zcode-cli` ignore，86 条 max-lines 入 lint 基线）；
  剩余的是缺口二（171 处行内豁免复核）与缺口三（棘轮对已超限文件增长不敏感），后者不是改 ignore
  能解决的问题。
- 门禁引擎、基线结构与退出码的 owner 是 `quality-gates.md`；本 spec 只记录对账，不再复述判定规则。
  修改 `.oxlintrc.json` / `.prettierignore` / 基线时必须同时给出门禁影响与当前违规计数。
- 不修改 `apps/zcode-cli-rust`。Rust 侧有自己的 `check-zcode-cli-rust-boundaries.mjs`。

## 建议的推进顺序

| 顺序 | 项                | 理由                                                                  | 预估     | 状态                 |
| ---- | ----------------- | --------------------------------------------------------------------- | -------- | -------------------- |
| 1    | P0-A              | 纯类型迁移，编译器兜底；上游仍欠所以本仓现在领先                      | 1 个 PR  | **已做**（da7185d1） |
| 2    | knip 进 CI        | 先拿到基线计数，否则后面重构没有 unused 证据                          | 1 个 PR  | **已做**（41bdb3a3） |
| 3    | CLI lint 覆盖     | 只纳入 lint；format 是版本边界、typecheck 已间接覆盖，均不强行并入    | 1 个 PR  | **已做**（e367c42f） |
| 4    | P2-A 缺口二       | 171 处行内豁免逐个复核；历史实测一半在 `packages/ui`                  | 持续     | 待做                 |
| 5    | P1-D              | 与 Rust TUI 的职责划分对齐；本仓已无登录流程，可简化                  | 按子域拆 | 待做                 |
| 6    | P1-B              | 依赖 P1-D 完成后再动 `deps.ts`，避免同一批文件改两次                  | 按域拆   | 待做                 |
| —    | P1-C / P1-F / CUA | 上游同样欠且无用户可见收益；CUA（e00ed2f8）只索引，不纳入 TS 治理排期 | —        | 暂缓                 |

## 验收

1. 每条目落地时，本 spec 的判定列更新为「已做」并附 commit；不接受「对账过就等于做完」。
2. P0-A：`rg "interface PermissionDecisionResult" apps/zcode-cli/packages` 只命中一处；
   `pnpm typecheck` 通过；相关 permission 测试通过。
3. 三个门禁进 CI：✅ **已完成** — workflow 的 `checks` job 依次跑 `pnpm gate:lint` / `gate:format` /
   `architecture:check` / `pnpm gate:knip`，退出码非 0 即阻断；基线为 lint 180 entries
   （231 诊断：86 error / 145 warning）、knip 1141、format 0，均记录在 `.gate-baseline/`。
   门禁测试为 36 单测 + 14 集成 = 50（本地实测全绿）。这些数字与 `OK / exit 0` 是**本地验证**；
   远端 CI 结果见上文「首轮远端 CI 实测」，不得据此声称 CI 已通过。
4. P2-A 缺口一：✅ **已满足** — 纳入前根 lint 不扫 CLI、CLI 自身 lint 红；纳入后根 lint 实测
   4318 个文件、231 条诊断（86 error / 145 warning）全部入基线，未按目录分批。
   但棘轮对已超限文件继续增长不敏感，不能据此声称 400 行已全覆盖（见「缺口三」）。
5. P1-D：`apps/zcode-cli/packages/cli/src/tui-*.ts` 归零；`@zcode/tui` 承担启动、locale、
   stderr、workspace 路径；CLI 包的 lint/typecheck/测试通过；Rust TUI 的两层划分保持不变。
6. 每次落地后跑 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`，如实记录。

## 本轮已执行

分四轮：第一轮只读对账（`1b1b7420`）；第二轮 knip 门禁（`41bdb3a3`）与 P0-A（`da7185d1`）；
第三轮 `e367c42f` 落地单文件棘轮门禁；第四轮（本次治理收尾）才把引擎抽成 `gate-ratchet.mjs` +
`gate-ratchet-core.mjs` 两层、补齐严格输入校验与 50 个测试。`e00ed2f8` 只做索引，不扩大范围。

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
- 根级三个门禁对 `apps/zcode-cli` 的覆盖：全部不覆盖（**第一轮当时**；现状见前文「门禁覆盖」，
  oxfmt 用对照实验确认）
- CLI 自身 lint 实测：`turbo run lint` 14 个任务，`@zcode/cli`/`@zcode/bootstrap`/`@zcode/tui` 失败；
  `@zcode/core` 单独 30 条 `max-lines` error

**实施（第二轮，`41bdb3a3` + `da7185d1`）**：

- knip 门禁：`scripts/ci/knip-ratchet.mjs` + `.knip-baseline.json`（1142 条，后被取代）
- P0-A：7 个文件收敛重复类型（见「落地结果（P0-A）」），knip 基线收紧到 1141

**实施（第三轮，`e367c42f`，门禁收尾）**：

- `e367c42f` 时 `scripts/ci/gate-ratchet.mjs` 仍是单文件脚本（IO/CLI、解析、比较、基线读写同在一处）；
  `gate-ratchet-core.mjs` 的抽离、严格输入校验与 50 个测试都是第四轮的事，不属于该 commit
- 基线：`.gate-baseline/{knip,lint,format}.json` = 1141 / 180（231 诊断）/ 0
- `package.json`：`gate:knip` / `gate:lint` / `gate:format` / `gate:baseline`，`verify:pre-push` 加入 lint+format
- `.oxlintrc.json`：**移除了 `ignorePatterns` 里的 `apps/zcode-cli`**（第一/二轮未改；本轮改动是本次收尾的一部分）
- `.prettierignore` 与根 typecheck project 列表**未改**：前者是版本边界，后者不要求强行覆盖
- 未触碰 `apps/zcode-cli-rust` / `packages/ui` 与用户数据；CLI 的 86 条超 400 行存量告警未清理，
  已入 lint 基线，拆分仍是后续工单

**治理收尾（第四轮，本次）**：

- 引擎分层：从单文件脚本抽出无 IO 的 `gate-ratchet-core.mjs`（解析、比较、基线序列化、报告），
  入口仍是 `gate-ratchet.mjs`；这一层在 `e367c42f` 时不存在
- 输入完整性收紧：knip/lint/format 的未知分类、缺字段、零扫描、基线结构损坏一律 exit 2
- 测试补到 36 单测 + 14 集成 = 50，并纠正入口复制需带相邻 `gate-ratchet-core.mjs`、
  `isMainModule` 的宿主语义与 knip `duplicates` 的文件级口径
- CI 调用点切到 `pnpm gate:lint` / `gate:format` / `gate:knip`；workflow 回归测试断言精确命令串，
  不得用 `continue-on-error` / `|| true` / `exit 0` 绕过
- 远端 CI 结果待 PR 后回填；本文与 `quality-gates.md` 同步写为实际落地状态

`e00ed2f8`（CUA 帧契约休眠）仅登记在 commit 索引：它不改门禁、不动基线，也不改变本文任何判定。
门禁判定、退出码、基线校验与 50 个测试的验收见 `quality-gates.md`。
