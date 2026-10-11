# 动态工作流留白能力（Dynamic Workflow Holes）

**当前状态：未实现。** 实现前需先与本 spec 对齐；本文只定义能力边界、联动面、验收与分期，
不引入代码。

## 背景

上游 3.15.1（`aac47556`）在 `apps/zcode-cli/packages/dynamic-workflow` 里新增了一条纵向能力
——**留白（Holes）**：脚本作者在写工作流时可以先留一个位置，等前面的步骤跑出结果后，再由主
代理为它补上函数体；在那个位置被补上之前，该分支停住等待，同一 run 的其他分支继续跑。

三条证据说明它是**真实能力**而不是重构：

1. 我们树里 `FillWorkflowHole` / `HOLE_CODE` **0 命中**（复核命令见
   [`upstream-sync-3.15.1.md`](./upstream-sync-3.15.1.md) 的「工作项 4」）。整个能力（facade
   符号、编译规则、引擎停驻表、线协议请求、工具、端口、v4 展示）在这边都不存在。
2. 它在协议、工具、权限、UI 四处都有自己的名字与载荷：`hole-reached` / `hole-filled` 事件、
   `FillWorkflowHole` 工具、`DynamicWorkflowRunHole` 快照条目、`workflowRuns` 归约分支。这些是
   产品面契约，不是内部重构。
3. 它改变了 run 的时序模型：一条分支可以在 `await hole<T>(...)` 处**长时间停驻**，而这在
   AskUser / AmendWorkflow 里没有对应物。这决定了移植必须带引擎、协议与宿主三处，不能只搬
   编译器。

上游把 `dynamic-workflow` 从 102 个文件扩到 2,058 个，其中 1,575 个是图分析期望输出快照、
`src` 只 120 个。留白是 `src` 增量里唯一成体系的新纵向能力，因此单独立项；其余增量按
`upstream-sync-3.15.1.md` 逐文件判定。

## 范围与非目标

**范围**：把留白作为本仓库的原生能力实现——facade 与编译规则、脚本降级、引擎停驻与补全集、
沙箱线协议、契约端口与 `FillWorkflowHole` 工具、bootstrap 驱动、v4 快照与 UI 展示。

**非目标**（沿用 [`upstream-sync-3.15.1.md`](./upstream-sync-3.15.1.md) 的 Non-goals）：

- 不搬 `apps/zcode-cli/packages/dynamic-workflow/src/testing/**`。
- 不 vendor `tests/**` 的期望输出快照与图分析夹具。
- 不搬依赖遥测 / 商业 / 官方鉴权的联动面（`packages/shared/src/{telemetry,...}` 等，见该 spec
  的「故意不跟」表）；留白本身不依赖这些。
- 不整包跟随 `dynamic-workflow` 的其他演进（`zcodeSessionProjection`、UI 产品面改版等）。
- 不引入新的 runner：验收测试用本仓库的 `node:test` 口径。

**与上游保持一致的部分**：协议事件名、`HOLE_CODE`（9012）、`hole#<8hex>` 站点 id 形状、
`FillWorkflowHole` 工具名与拒绝原因字符串、v4 `WorkflowRunHole` 字段。这些是跨端契约，改名会
让后续与上游对照失去锚点。

## 能力边界

以下四个概念取自上游源码（`aac47556`，路径为上游路径），用本仓库的表述写清，便于评审对齐。

### 1. 留白站点如何被识别（编译期）

facade 里声明三个重载：

```ts
hole<T>(name: string, prompt?: string): Promise<T>;
hole<T>(name: string, body: () => Promise<T>): Promise<T>;
hole<T>(name: string, prompt: string, body: () => Promise<T>): Promise<T>;
```

`src/analysis/hole-sites.ts` 在分析器那一趟里按实参形状分派：第二实参是函数字面量即函数体，
否则是提示；第三实参（若有）是函数体。站点 id 由 `src/analysis/hole-id.ts` 的
`holeSiteId(name)` 从名字铸出——名字 trim 后按 Unicode 码点做 FNV-1a 32 位哈希，写成
`hole#<8 位十六进制>`。**键是名字，不是位置**：这样补全在脚本中间插代码时，插入点之后的留白
不会改号，journal 键、ask 规格表、站点阶段表都能在补全前后幸存。名字在整个有效脚本里唯一，
体内再留的留白自己又是 `hole#<hash>`，嵌套关系记在站点表的 `fill` 字段而不是 id 前缀。

编译期规则集中在 `HOLE_CODE = 9012`（与 9003 / 9004 同席），每条都是「与其运行期才炸，不如让
分析器现在就报」：

- 类型实参必须显式写出（推断出的 `unknown` 不是补全要检查的契约）；
- 名字必须是非空字符串字面量，长度 ≤ `HOLE_NAME_MAX_CHARS = 128`，且在脚本的留白与阶段标记
  中唯一（两个标记同名是一个阶段，两个留白同名却是两个缺口）；
- 调用必须被 `await`；
- 不能落在 fan-out 回调（数组方法的回调）里——元素并发跑，补全没法在它们已经在跑时写；
  `for...of` 体允许，因为带 `await` 的 `for...of` 是顺序的，补全到了一轮一轮跑；
- 函数体必须是内联函数字面量（lowering 要把它原样打印成补全文本）；
- 函数体不得引用留白之后才声明的绑定（函数体是编译器不检查「先用后声明」的闭包，运行期会
  TDZ 抛错）。

`FACADE_HOLE_SEGMENT`（`src/facade/dts-hole.ts`）只拼进**完整 facade，不进 snippet facade**：
片段没有 run，也就没有可等主代理补全的东西。

### 2. 如何 splice（编译期 → 有效脚本）

`src/analysis/hole-splice.ts` 提供两件纯文本工具：

- `spliceHoleBody(scriptText, table, holeSiteId, body)`：把 `body` 作为**最后一个实参**拼进
  留白调用——在最后一个实参末尾插入 `, async () => {\n<body>\n}`，函数体每行按调用所在行的
  缩进再加 2 格，右花括号取调用的缩进。插入点是「最后一个实参的末尾」而不是右括号之前：作者
  常按 prettier 习惯写 `hole<T>(\n  "名",\n  \`提示\`,\n);`，尾随逗号会让「右括号前插入」得到
`, , async`，而接在实参末尾之后则得到合法的 `}, \n)`，原注释与尾随逗号都保留。返回
`insertedAtLine`/`insertedLines`，供诊断把行号分到函数体内还是草稿内；留白不在表里或已有
函数体时返回 `undefined`。
- `checkSiteStability(before, after, holeSiteId, insertedAtLine, insertedLines)`：补全前后站点
  id 的稳定性复核。`before` 的每个 id（全部种类）都要在 `after` 里，位置不变，或落在插入点
  之后时行号整体后移 `insertedLines`；`after` 里新出现的 id 必须是这次补全写下的（带
  `<holeSiteId>/` 前缀，或 `fill` 链通到该留白）。任何一条不成立都是宿主故障
  （`fill_ids_unstable`），run 不能拿到它接不上的 id。

补全产出的脚本是**有效脚本**：它被写回 run 行（`updateRunScript`），所以 resume 重放时函数体
内联执行、shim 不过线、`hole-reached` 不再出现。

### 3. runtime 的 `hole` request 是什么（沙箱线协议）

`dynamic-workflow-runtime/src/protocol.ts` 是 NDJSON 线协议的**唯一真源**，child → parent 的
`RequestMessage` 上有一个 `type: "hole"`：

```ts
interface RequestMessage {
  kind: "request";
  id: string;
  type: "ask" | "world-read" | "publish-artifact" | "hole";
  siteId: string;
  name?: string; // hole 专属：留白的字面名
  prompt?: string; // hole 专属：给主代理的提示（引擎记录前截到 4000 字符）
  // ...
}
```

脚本到达一处未补全的留白时，子进程发这条 request，父进程经引擎把它停下，直到主代理补全，再以
`{ code }` 应答——`code` 是有效脚本 lowering 出的 `holeBodies[siteId]`，即 `(async () => {…})`
的文本，不是主代理手写的源码。停驻的分支是一条**在飞请求**：兄弟分支照跑，停滞检测不响。已补全
的留白不再过线。子进程源码 `child-source.ts` 里以纯手写方式镜像这些形状（无法 import 本模块），
父进程侧直接 import 类型，两处必须一起改。

### 4. facade / 包暴露了什么符号

上游 `src/index.ts` 与各模块对外暴露（节选）：

| 符号                                                      | 来源                          | 作用                                |
| --------------------------------------------------------- | ----------------------------- | ----------------------------------- |
| `hole`（三个重载）                                        | `src/facade/dts-hole.ts`      | 脚本可见的留白原语，只进完整 facade |
| `HOLE_CODE` = 9012                                        | `src/analysis/hole-sites.ts`  | 留白编译诊断码                      |
| `HOLE_NAME_MAX_CHARS`                                     | 同上                          | 名字长度上限                        |
| `collectHoleDiagnostics`                                  | 同上                          | 收集 9012 诊断                      |
| `HoleSite` 类型                                           | `src/analysis/sites.ts`       | 站点表的留白条目                    |
| `spliceHoleBody` / `SplicedHoleBody`                      | `src/analysis/hole-splice.ts` | 拼接与稳定性复核                    |
| `holeSiteId` / `holePrefixOf` / `isHoleSiteId`            | `src/analysis/hole-id.ts`     | 名字键与 id 形状                    |
| `HoleRegistry` / `reachHole` / `fillHole`                 | `src/engine/engine-holes.ts`  | 引擎停驻表与补全                    |
| `HoleFill` / `FillHoleResult` / `OpenHole` / `FilledHole` | 同上                          | 补全请求与快照投影                  |
| `HOLE_PROMPT_MAX_CHARS` = 4000                            | 同上                          | prompt 截断上限                     |

## 需要联动的包与文件

路径以上游 `aac47556` 为准；移植时删掉上游特有的遥测 / 商业引用，其余按本仓库的导入规范改。
「所有者 / 纪律」列写明每层唯一的写入口。

| 层                           | 上游文件（示例）                                                                                                                                                                                                                        | 作用                                                                                     | 所有者 / 纪律                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `dynamic-workflow`（编译）   | `src/analysis/hole-sites.ts`、`hole-id.ts`、`hole-splice.ts`、`sites.ts`                                                                                                                                                                | 站点识别、9012、拼接与稳定性复核                                                         | 站点表是编译产物唯一真源；id 只由名字铸                  |
| `dynamic-workflow`（降级）   | `src/lowering/lower-hole.ts`                                                                                                                                                                                                            | 把 `hole` 调用改写成 `__host.hole(siteId, name, prompt, (__src) => eval(__src)[, body])` | 与其余站点同一趟 transform                               |
| `dynamic-workflow`（引擎）   | `src/engine/engine-holes.ts`、`engine.ts`、`engine-state.ts`                                                                                                                                                                            | 停驻表、`hole-reached` / `hole-filled`、`updateRunScript`                                | `HoleRegistry` 是唯一内存所有者；无 journal node 行      |
| `dynamic-workflow`（facade） | `src/facade/dts-hole.ts`、`src/index.ts`                                                                                                                                                                                                | 暴露 `hole` 与上述符号                                                                   | 只进完整 facade                                          |
| `dynamic-workflow-runtime`   | `src/protocol.ts`、`harness.ts`、`child-source.ts`                                                                                                                                                                                      | `hole` request 与 `{code}` 应答                                                          | 线协议唯一真源；child-source 手写镜像                    |
| `contracts`                  | `src/interfaces/dynamic-workflow-run-hole.port.ts`、`dynamic-workflow-run.port.ts`、`src/tools/fill-workflow-hole.ts`、`get-workflow-run.ts`、`create-workflow.ts`                                                                      | 端口读面 `holes[]`、`fillHole` 方法、工具契约与拒绝原因                                  | `fillHole` 端口方法是唯一补全写入口                      |
| `bootstrap`                  | `src/app/dynamic-workflow-run-holes.ts`、`dynamic-workflow-run-fill.ts`、`dynamic-workflow-run-service.ts`、`dynamic-workflow-run-launch.ts`、`dynamic-workflow-run-replay.ts`、`dynamic-workflow-run-observation.ts`                   | 驱动补全：拼接、编译、稳定性检查、改草稿、投影快照                                       | run service 按序调用；纯合成规则无 I/O                   |
| `core`                       | `src/tool/handlers/fill-workflow-hole.ts`、`fill-workflow-hole-description.ts`、`fill-workflow-hole-resolve.ts`、`fill-workflow-hole-splice.ts`、`get-workflow-run.ts`、`src/runtime/methods/dynamic-workflow-run-hole-notification.ts` | 工具 handler、确认窗预览、`hole-reached` 通知                                            | 每条 `hole-reached` 恰好一条通知；`hole-filled` 不发通知 |
| `shared`（v4 展示）          | `packages/shared/src/zcode-protocol-v4/workflow-runs-holes.ts`、`workflow-runs-reducer.ts`、`workflow-runs.ts`                                                                                                                          | `hole-reached` / `hole-filled` 归约、`phaseHoles` 下标、上限                             | reducer 是纯函数；`waiting` 只由引擎停驻表决定           |
| `ui` / `desktop`（展示）     | `packages/ui/src/components/workflow-timeline/**`、`app-shell/WorkflowRunPhaseList.tsx`、`v4/WorkflowNotificationHoleRow.tsx`、`ToolCallBlocks/renderers/workflow-fill-row.tsx`、`WorkflowPermissionHoles.tsx`                          | 时间线上把留白站画成虚线灯、通知行、补全工具行与确认窗                                   | 展示只读 v4 归约结果，不自算状态                         |

`packages/shared/src/diagnosticLogCatalog.ts` 由 `node scripts/diagnostic-log-catalog.mjs` 扫描
生成：任何新增/删除源码文件后必须重跑，否则新增日志模块不进词表。

## 验收场景

1. **未填充留白时运行**：脚本在 `await hole<T>("名", "提示")` 处停住——分支停驻、`hole-reached`
   进 journal、主代理收到一条模型可见通知；同一 run 的其他兄弟分支继续跑；停滞检测不报；快照
   的 `holes[]` 该条目 `state: "waiting"` 且带 `since`。
2. **填充后 splice 的结果**：`FillWorkflowHole` 提交函数体后，有效脚本里留白调用被改成
   `hole<T>("名", "提示", async () => { … })`（函数体接在最后一个实参末尾，缩进 = 调用缩进 + 2），
   拼好的有效脚本写回 run 行；停驻分支以 `{code}` 放行并继续；本世之后再次到达同一站点时直接
   用记住的代码作答，**不再停驻、不再记 `hole-reached`**。
3. **错误码与 HOLE_CODE 的触发条件**：
   - 分析期 `HOLE_CODE = 9012`：缺显式类型实参、名字非字面量 / 空 / 超 128 字 / 与留白或阶段
     标记重名 / 哈希撞车、未 `await`、落在数组方法回调里、函数体非内联、函数体引用晚声明绑定
     ——任一条都让脚本不可提交。
   - 补全被拒的结构化原因：`run_not_found`、`hole_not_waiting`（已补 / 还没到 / 未知 id）、
     `compile_failed`（带 `diagnostics`，草稿不动、留白照旧在等）、`fill_ids_unstable`（站点改号，
     宿主故障）。
4. **journal 里能看到什么**：留白本身**没有** `dwf_node` 行（它不是会自己结算的节点）；journal
   里是 `hole-reached`（`instance.siteId` + `ordinal`、`name`、截断后的 `prompt`）、
   `hole-filled`（`siteId`、`filledAt`、`filledBy`、新的 `phaseNames`、`holes` 下标、`scriptPath`）
   与 `run-launched.holes`（开放留白在阶段表里的下标）。resume 重放有效脚本时体内联执行，
   shim 不过线。
5. **截断与上限边界**：`hole-reached` 的 prompt 超 4000 字符截到上限并以 `…` 收尾（通知与 v4
   又各自再截一次）；留白名字 > 128 被 9012 拦下；快照 `holes[]` ≤ 32 条；v4 归约对
   `phaseNames` / `phaseHoles` / prompt / type 各有上限，越界或重复的下标被丢弃。
6. **并发与生命周期边界**：同一站点在循环里停驻多个 ordinal 时，一次补全放行该站点下**所有**
   停驻分支；`fillHole` 对已结算 run 返回 `settled`、对该站点既不在等又没补过返回 `not_waiting`，
   两条都**不写不发**；run 结算时停驻分支以结算错误拒绝、补全记忆保留；resume 从空停驻表起，
   重跑到未补站点会再记一条 `hole-reached`。
7. **展示**：时间线把开放留白画成虚线灯、补全后阶段表按插入位置右移（`phaseAlongside` 的
   `+k` 规则）；`FillWorkflowHole` 行复用 `CreateWorkflow` 的输出形状；通知行点击能定位到该
   留白的站点 id。

## 分期计划

```text
P1  契约 + 引擎：contracts 端口（holes[] / fillHole）、dynamic-workflow 的 analysis /
    lowering / engine-holes、runtime 的 hole request 与 {code} 应答。
P2  bootstrap + core：run service 的拼接 / 编译 / 稳定性检查 / 改草稿、快照投影、
    FillWorkflowHole 工具与权限、hole-reached 通知。
P3  展示：shared v4 归约（hole-reached / hole-filled / phaseHoles）、UI 时间线、通知行与
    补全工具行、确认窗。
```

依赖方向：

```text
dynamic-workflow（编译 + 引擎）
  └─ dynamic-workflow-runtime（沙箱协议）
contracts（端口 + 工具）
  ├─ bootstrap（驱动与投影）
  └─ core（runtime method + 通知 + handler）
shared v4（归约）
  └─ ui / desktop（展示）
```

P1 完成前不落 P2，P2 完成前不落 P3；每期各自补测试与验收，且必须先跑
`node scripts/check-workspace-freshness.mjs` 与 `pnpm typecheck` / `pnpm lint`。

## 待确认问题清单

1. **是否跟随上游的站点 id 形状**：`hole#<8 位十六进制>` 由名字的 FNV-1a 哈希铸出。我们要不要
   保持逐字节一致？不一致会让与上游 journal 对照失去锚点，但一致意味着继承其哈希撞车语义。
   目前不知道本仓库有没有别处依赖该形状。
2. **停驻与进程死亡**：进程亡故后停驻的 promise 消失，快照的 `waiting` 只在引擎停驻表里有它时
   成立。resume 会重跑到该站点并再记一条 `hole-reached`。但「主代理在 run 停驻期间重启 / 切换
   会话」时，通知与补全入口如何保证不丢，还没读清。
3. **fill 文件的落地策略**：上游把被拒的内联提交写成 fill 文件、下一次按 `path` 交回。文件放在
   本仓库的哪个数据根（`appDirNames.ts` 的 `ZCODE_USER_DATA_DIR_NAME` 还是 run 草稿旁）？保留
   多久、如何清理？
4. **权限与确认**：`FillWorkflowHole` 的免确认规则是「run 归本会话且不是用户亲手停下的」。
   本仓库的权限模型（`core/src/tool/handlers` 与 `permission/service.ts`）是否需要另一条
   approval 路径？目前不知道本仓库是否有对应 owner 概念。
5. **与 Rust 重写的关系**：留白是 Node CLI 的能力。Rust 重写是否要等价实现、还是只保留 Node
   侧、由 Rust 调用？这决定 P2 的工作是否会被重写覆盖。
6. **UI 展示范围**：上游时间线的留白灯、`phaseAlongside` 右移与「补全生长」动画是一整套视觉；
   我们只做最小可用的虚线灯 + 通知行，还是跟随？本仓库的 `DESIGN.md` 是否允许该视觉，尚未对齐。
7. **测试与 CI 口径**：上游留白测试多在 `tests/**`（本 spec 明确不 vendor 快照）。我们要新写
   哪些 `node:test` 用例、是否接入 `scripts/ci/*.test.mjs` 门禁，尚无定论。
8. **诊断日志词表**：`diagnosticLogCatalog.ts` 的生成脚本扫描全仓源码；留白新增的日志模块命名与
   前缀如何登记，会不会触发词表校验，需要确认。

## 定案（P1 开始前）

所有者叫「开始编码」后，对上面 8 条待确认问题逐条取保守结论。原问题保留，结论如下。

1. **id 形状：与上游逐字节一致。** 保持 `hole#<8 位十六进制>`，名字 trim 后按 Unicode 码点做
   FNV-1a 32 位哈希（`analysis/hole-id.ts` 的 `holeSiteId`）。理由：与上游 journal 对照保持锚点，
   且名字键是补全前后站点稳定的根基。哈希撞车沿用上游语义——9012 报错、绝不猜；两个不同名字
   撞到同一 id 时脚本不可提交。本仓库别处不依赖该形状（`FillWorkflowHole` / `HOLE_CODE` 在基线
   0 命中）。
2. **与 Rust 重写的关系：P1 只做 Node 侧。** Rust 是否等价实现待定，不影响本期；本期交付的契约
   与线协议不假设 Rust 会重写。
3. **fill 文件落地：P1 不涉及（属 P2）。** 只记录方向——被拒的内联提交写成 fill 文件时，用
   `packages/shared/src/appDirNames.ts` 的数据根，不放 run 草稿旁；保留时长与清理策略留到 P2 定。
4. **权限 / 确认：P1 只落契约与端口。** 是否免确认留到 P2；P1 **不引入新的 approval 路径**，
   `FillWorkflowHole` 的 handler 与权限判定不在本期。
5. **UI 展示：P3 再定。** P1/P2 不做 UI（v4 归约、时间线虚线灯、通知行、确认窗都留到 P3）。
6. **测试与 CI：新写 `node:test`，不 vendor 上游 `tests/**`快照。** 用例放在`apps/zcode-cli/packages/dynamic-workflow/test/_.test.ts`，并给该包加 `test`脚本，风格与`apps/zcode-cli/packages/contracts/package.json`一致：`node --import tsx --test --test-isolation=none test/_.test.ts`。这样它会被 CI 里已有的
`pnpm -r --filter './apps/zcode-cli/packages/_' test`步骤自动拾取。不接入`scripts/ci/_.test.mjs`。
7. **诊断日志词表：新增/删除源码文件后必须重跑** `node scripts/diagnostic-log-catalog.mjs`。
   留白本身不新增日志模块；若脚本扫描变化，则重跑生成并跑 oxfmt。
8. **站点表 / 阶段表：按上游语义。** 两个阶段标记同名是**一个**阶段（名字继续同一阶段）；两个
   留白同名是**两个**缺口，被 9012 拒绝。留白按名字占阶段表的一个位置。

以上结论不改变本文前面对能力边界、所有者与分期计划的定义。

## 当前状态

**P2 实现中。** 本文的 8 条待确认问题已在上面的「定案（P1 开始前）」逐条收敛；P1（契约 + 编译 +
引擎 + 线协议）与 P2（bootstrap 驱动 + core 工具与通知）按下面的「移植记录」推进。P3（展示）未开始。

### P1 移植记录（与上游 `aac47556` 对照）

**整文件移植（内容与上游一致，导入路径按本仓库规范、去掉遥测/商业引用）：**

- `dynamic-workflow/src/analysis/hole-id.ts`
- `dynamic-workflow/src/analysis/hole-sites.ts`
- `dynamic-workflow/src/analysis/hole-splice.ts`
- `dynamic-workflow/src/engine/engine-holes.ts`
- `dynamic-workflow/src/facade/dts-hole.ts`（只进完整 facade，不进 snippet facade）
- `dynamic-workflow-runtime` 的 `protocol.ts` / `harness.ts` / `child-source.ts` 的 hole hunk
- `contracts/src/interfaces/dynamic-workflow-run-hole.port.ts`
- `contracts/src/tools/fill-workflow-hole.ts`

**hunk 合并（同名文件只取留白相关改动，其余本仓库自有改动保留）：**

- `analysis/sites-labels.ts`（`Counter` → `SiteCounters`）、`analysis/sites.ts`（留白站点条目）、
  `analysis/facade-misuse.ts`、`analysis/analyze.ts`
- `compiler/compile.ts`（`SCRIPT_PRELUDE_LENGTH`）、`facade/registry.ts`（`hole` 进站点函数清单）、
  `facade/dts.ts`（拼入 `FACADE_HOLE_SEGMENT`）
- `lowering/lower.ts`、`engine/engine.ts`、`engine/engine-state.ts`（仅 `journal.updateRunScript` 接缝）、
  `engine/engine-phase-stamp.ts`、`engine/engine-launch.ts`、`engine/journal-memory.ts`、
  `engine/types.ts`
- `contracts/src/interfaces/dynamic-workflow-run.port.ts`、`contracts/src/tools/get-workflow-run.ts`
- `dynamic-workflow/src/index.ts`、`dynamic-workflow/src/engine/index.ts`

**本期不做（留给后续分期）：** `shared` v4 归约、UI、`analysis/{core,interpret,causality-*,
flow-graph,site-phases,actor-models}.ts` 的图/阶段集成、fill 文件落地策略与权限。

### P2 移植记录（与上游 `aac47556` 对照）

**新增文件：**

- `bootstrap/src/app/dynamic-workflow-run-holes.ts` — 纯合成规则：`compiledHolesOf`、
  `openHoleIndexes`、`readRunHoleEvents`、`phaseNamesFromEvents`、`projectRunHoles`、
  `coldCompiledHoles`、`runHolesOf`、`mapFillDiagnostics`。无 I/O、无状态。
- `bootstrap/src/app/dynamic-workflow-run-compile.ts` — 把 `compileOnce` / `compileProgram` /
  `boundedResumeDiagnostics` 从 `dynamic-workflow-run-submit.ts` 拆出，并新增
  `collectSitePhasesOf` / `phaseNamesOfFlow` 两条宿主侧投影；`CompiledDynamicWorkflowScript`
  补 `holeBodies` / `holes`。
- `bootstrap/src/app/dynamic-workflow-run-fill.ts` — `fillDynamicWorkflowHole`：同一 run 的补全
  串行化、拼接 / 编译 / 稳定性校验 / 交引擎 / 改草稿。拒绝即零副作用。
- `core/src/tool/handlers/fill-workflow-hole.ts` / `-description.ts` / `-resolve.ts` /
  `-splice.ts` — 工具声明、描述、`resolveInput`、`path` 来源归一化与确认窗预览。
- `core/src/runtime/methods/dynamic-workflow-run-hole-notification.ts` — `hole-reached` →
  恰好一条模型可见通知；`hole-filled` 不发。

**hunk 合并（本仓库自有改动保留）：**

- `bootstrap/src/app/workflow-run-control.ts`（控制面加 `fillHole` / `openHoles`）
- `bootstrap/src/app/dynamic-workflow-run-observation.ts`（`RunRegistryEntry.holes` /
  `phaseNames`、快照 `holes[]` 投影）
- `bootstrap/src/app/dynamic-workflow-run-introspection.ts`（详情面 `holes[]`）
- `bootstrap/src/app/dynamic-workflow-run-service.ts`（端口 `fillHole` + `fillQueues`）
- `bootstrap/src/app/dynamic-workflow-run-submit.ts`（`run-launched.holes`、条目 `holes` /
  `phaseNames`、resume 从事件读回阶段表）
- `bootstrap/src/app/dynamic-workflow-run-launch.ts`（`CompiledDynamicWorkflowScript` 新字段）
- `contracts/src/tools/create-workflow.ts`（`CreateWorkflowOutput.fill`）
- `core/src/tool/handlers/get-workflow-run.ts`（模型面 `holes[]`）
- `core/src/tool/handlers/{workflow-path-source,workflow-drafts,workflow-draft-read-state}.ts`
  与 `core/src/tool/read-file-state-metadata.ts`（导出补全需要的路径/铸名函数，登记
  `FillWorkflowHole` 为作者工具）、`core/src/tool/handlers/index.ts`（注册工具）、
  `core/src/runtime/methods/dynamic-workflow-run-progress.ts`（接上留白通知）
- `core/src/runtime-task/workflow-notification-copy.ts`（`formatWorkflowHoleNotification`）

**与上游的偏差（先记 spec、再改代码）：**

1. **缺 `collectSitePhases` / `collectPhaseNames`（P1 分析层未落）。** 上游在
   `dynamic-workflow/src/analysis/site-phases.ts` 导出这两条；本仓库 P1 没落该文件。P2 在宿主侧
   实现等价投影：`collectSitePhasesOf(core)` 与 `phaseNamesOfFlow(flow)`（bootstrap 的
   `dynamic-workflow-run-compile.ts`）。
2. **`ActorEvent` 还没有 `phase` 字段。** 上游的 `collectSitePhases` 对 issue 与 spawn 都做
   词法盖戳；本仓库 `causality-order-types.ts` 的 `ActorEvent` 只有 `actor` / `regions`，所以
   `collectSitePhasesOf` 只对 issue 事件盖戳；actor 站点仍退回动态当前阶段，与 P1 行为一致。
   补 `ActorEvent.phase` 属 P3 的分析层集成。
3. **`flow-graph.ts` 还没有 `FlowHole` / `collectFlowHoles`，且分析层的留白集成未落。** 阶段表
   （因果图 / 控制流投影）目前**不含留白名**，所以 `openHoleIndexes(phaseNames, holes)` 对现有脚本
   会回 `undefined`，`run-launched.holes` 与 `hole-filled.holes` 暂时缺席；开放留白的阶段下标因此
   用「留白名对表」从宿主侧算，不读 `flow.holes`。两条规则在 9012「留白名唯一且占一个阶段」下等价，
   但要让阶段表真含留白名（侧栏虚线站在位）需要 P3 的分析层集成。
4. **`CreateWorkflowOutput` 只加 `fill` 块，不加 `holes[]` / `Step.fill` / `phaseStreams`。**
   图展示面（display 契约）属 P3。
5. **通知只发模型可见文本，不带 `workflowNotification` manifest。** manifest 的 `kind: "hole"`
   要 shared v4 schema 同步（属 P3）；P2 只落 `formatWorkflowHoleNotification` 文本。
6. **fill 文件落地、权限确认窗与 `model_bindings` 检查未落。** P2 的 `resolveInput` 只归一 `script`
   / `path` 与 `hole` 事实块、拼确认窗预览；内联提交写 fill 文件、`fill_unchanged` 之外的 fill 文件
   生命周期、`allScriptModelsBound` 与权限 owner 放行留到 P3（见报告）。
7. **`run-launched.holes` 由提交方按编译产物与声明表算出**（`openHoleIndexes`），与上游同规；
   resume 的阶段表从 `run-launched` / 最后一条 `hole-filled` 读回。

**P2 测试：**

- `bootstrap/test/dynamic-workflow-run-holes.test.ts` — 补全成功路径、`run_not_found`、
  `hole_not_waiting`（未知 id / 已补 / not live）、`compile_failed` 草稿不动、`checkSiteStability`
  的 `fill_ids_unstable` 判据、快照 `holes[]` 两态与 32 条上限、`compiledHolesOf`。
- `core/test/dynamic-workflow-run-hole-notification.test.ts` — 每条 `hole-reached` 恰好一条通知、
  `hole-filled` 不发、端口缺席时通知照发。
