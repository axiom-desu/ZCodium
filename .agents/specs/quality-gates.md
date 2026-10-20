# 质量门禁（Quality Gates）

状态标记：**✅** 当前 checkout 已实现并有本地实测证据；**⛔** 本 spec 定义、尚未实现（收尾待办）。
本轮收尾后没有 ⛔ 项；明确接受的残余限制（knip 零扫描、duplicates 只到文件级）见「已知不敏感」。
本文件是门禁判定语义的唯一所有者；`upstream-code-review-parity.md` 与 `formatting-gate.md`
只引用这里的结论，不复述判定规则。

## 范围与所有者

- **一个 IO/CLI 引擎 + 一个无 IO 纯解析层，不是三份引擎**：
  - `scripts/ci/gate-ratchet.mjs`：唯一的 IO/CLI 引擎。进程调用（`spawnSync` + `process.execPath`）、
    工具定位、基线读写、CLI 参数校验、退出码都在这里。
  - `scripts/ci/gate-ratchet-core.mjs`：无文件/进程 IO 的纯解析与比较层。key 编解码、三个解析器
    （knip/lint/format）、`compareEntries`、`parseBaseline`/`serializeBaseline`、`formatReport`
    都在这里；引擎用 `export * from "./gate-ratchet-core.mjs"` 转出，入口仍是 `gate-ratchet.mjs`。
- **三个 gate 只是同一个引擎里的适配器**（`ADAPTERS`），各自只声明
  `pkgName` / `binFileName` / `args` / `allowedExitCodes` / `collect`。
  比较、报告、基线读写、退出码只有一个实现，避免三份脚本的指纹格式与退出码判定漂移。
- **基线唯一存放处**：`.gate-baseline/<gate>.json`，每个 gate 一个文件，便于单独审阅 diff。
- **npm 入口**：`pnpm gate:knip` / `gate:lint` / `gate:format`（check），`pnpm gate:baseline`
  （依次刷新三个基线）。
- **两处调用点**：`verify:pre-push` 是 `gate:lint && gate:format && architecture:check --changed`，
  **不含 knip**；CI 的 `checks` job 依次跑 `gate:lint` → `gate:format` → `architecture:check` →
  `gate:knip`（其中 lint/format/knip 是本 spec 的三个 gate，architecture 由另一脚本拥有），
  任一失败即阻断。
- **不拥有**：原始真值命令 `pnpm knip` / `pnpm lint` / `pnpm fmt:check`（保留为全量报告，
  存量债务会报错，属预期）。也不拥有 `apps/zcode-cli` 自己的 `typecheck` 与格式器。
- **非目标**：不把 CLI 的 format/typecheck 强行并入根门禁。CLI 的格式器版本不同，跨目录改写会互相
  推翻（见 `formatting-gate.md` 的版本边界）；typecheck 由 CI 的 agent build 间接覆盖。
  **本次只关闭根 lint 盲区**（`e367c42f`）；format 与 typecheck 的盲区仍然保留，是有意接受，
  不是遗漏。

## 统一模型与判定

适配器产出 `Map<key, count>`，基线同构。key 由 NUL 分隔，**不含行号/列号**：代码移动不产生基线抖动。

| gate   | key                                | count 语义                                   |
| ------ | ---------------------------------- | -------------------------------------------- |
| knip   | `knip\0<kind>\0<file>\0<name>`     | 集合：恒为 1                                 |
| lint   | `lint\0<severity>\0<code>\0<file>` | 计数：同一 (severity, code, file) 的诊断条数 |
| format | `format\0<file>`                   | 集合：恒为 1                                 |

knip 的 `duplicates` 在真实 JSON 报告里是「组 → 成员」的嵌套数组，基线把它按文件折叠成一条
`name` 为空的 key（实测 12 个文件；限制见「已知不敏感」）。

- **比较**：当前 count 高于基线（含基线不存在的新 key）→ regression；低于 → improvement；
  相等 → 忽略；基线有而当前没有 → improvement。
- **退出**：有 regression → `1`；否则 `0`（即使有 improvement，或 entries 归零）。
- **告警零是合法终态**：`format` 当前就是 0/0，`format: OK` + exit 0。基线与当前同时为 0 不是错误，
  不得为了「看起来在管」注入条目，也不得因 `entries: 0` 跳过 gate。
- **improvement 只提示收紧，不阻断**。债务清零后收紧基线是正常路径，不是门禁失效。
- 基线缺失 ≠ 基线损坏：缺失按空基线比较（当前若有条目则全部算新增 → exit 1；两边都空则 exit 0），
  并提示生成命令；损坏必须 exit 2，不能静默当成空基线。

## 退出码契约

| code | 含义     | 触发                                                             |
| ---- | -------- | ---------------------------------------------------------------- |
| 0    | 干净     | 比较完成，regressions 为空（可以有 improvements）                |
| 1    | 回归     | 新增 key 或 count 上升                                           |
| 2    | 无法判定 | 未知 gate/命令、工具执行失败、输出无法理解、扫描零文件、基线损坏 |

- `2` 必须与 `1` 可区分：门禁自身坏掉不能伪装成「有债务」或「干净」。
- CI 不得用 `continue-on-error`、`|| true`、`exit 0` 包装 gate；工具失败不得降级。
- 也不得把「解析不了」当成空集合：那等价于全部 improvement → exit 0，是最坏的静默放行。

## 输入完整性

**✅ 已实现**（36 个单测 + 14 个集成测试覆盖；运行方式见「测试与验收」）：

- knip：空输出、非 JSON、缺 `issues` 数组 → exit 2。
- lint：找不到 `{`、JSON 非法、缺 `diagnostics` 数组 → exit 2；容忍 JSON 之前的人类可读前缀
  （从第一个 `{` 截取，实测 oxlint 会先打印 `No files found to lint...`）。
- lint 实扫文件数为正：`parseLintOutput` 要求 `number_of_files` 是 ≥1 的安全整数；
  缺失、为 0、小数、负数 → exit 2。实测空目录下 `oxlint --format json` 输出
  `No files found to lint...` + `"number_of_files": 0` + exit 1；当前正常扫描为 4318 个文件。
- lint 诊断必须可理解：`severity ∈ {error, warning}`，`code`、`filename` 为非空字符串；否则 exit 2。
  旧实现会把缺字段诊断收成 `lint\0unknown\0\0` 幽灵 key，现已由单测锁死。
- knip 未知分类必须拒绝：issue 对象除 `file`/`owners` 外的字段必须都在 `ISSUE_KINDS` 内；
  `file` 必填；条目项必须有非空 `name` 字符串；`duplicates` 必须是「组数组 → 成员数组」的嵌套形状；
  否则 exit 2。`ISSUE_KINDS` 现含 `nsExports` / `nsTypes`；`owners` 是 json reporter 在有
  CODEOWNERS 时输出的元数据，不是分类，允许但忽略。这样 knip 升级新增分类时不会静默放行。
- format：`exit 1` 但解析不到任何文件路径 → exit 2（`assertFormatResultConsistent`）。
- 基线结构合法：`version === 1`；顶层只允许 `version`/`entries`；`entries` 为数组；每项只允许
  `key`/`count`；`key` 为非空字符串、段数与 gate 匹配、首段等于请求的 gate、路径段是规范仓库相对
  形式（不含反斜杠、绝对路径、盘符路径或 `..` 逃逸）；`count` 为 ≥1 的整数，且 knip/format 必须恰为 1；
  不得出现重复 key；否则 exit 2。
- 基线文件存在但 JSON 非法 → exit 2（`parseBaseline`）。

**knip 零扫描仍是已知残留（不承诺检测）**：knip 的 JSON 只有 `issues`；实测空项目返回
`{"issues":[]}` + exit 0，无法与「确实干净」区分。集成测试用 fixture 锁死当前行为，避免以后误以为
已覆盖。lint / format 的零扫描已由上面的 `number_of_files` 校验与 oxfmt 的 exit 1/2 语义覆盖。

## 入口与路径

- **✅ CLI 入口 URL 安全匹配**。判定抽成纯函数
  `isMainModule(moduleUrl, entryPath)`：
  `moduleUrl === pathToFileURL(path.resolve(entryPath)).href`。
  旧守卫 ``import.meta.url === `file://${process.argv[1]}` `` 在路径含空格时必然不等
  （实测 `/tmp/space probe/t.mjs`：`file:///tmp/space%20probe/t.mjs` vs
  `file:///tmp/space probe/t.mjs`，进程**不执行 main 却 exit 0**）；中文与百分号同理。
  入口判定自身抛错时 exit 2，不静默 exit 0。
  - 集成测试把入口复制到含空格/中文/百分号的临时目录时，**必须同时复制相邻的
    `gate-ratchet-core.mjs`**：入口静态 import 它，只复制 `gate-ratchet.mjs` 会
    `ERR_MODULE_NOT_FOUND`。这是实测约束，不是可选清理。
  - `isMainModule` **按宿主语义**工作：`path.resolve` / `pathToFileURL` 的行为由运行平台决定。
    单测只锁死 posix 的 URL 编码匹配；Windows `C:\...` 用例以
    `process.platform === "win32"` 作为期望值。在 Linux 上无法伪测 Windows 的执行语义，
    真实 Windows 未在本环境实测，不能写成「已验证 Windows」。
- **✅ 采集时路径归一**：`\` → `/`、去掉前缀 `./`、`path.posix.normalize`；key 中只允许仓库根相对
  路径；绝对路径、盘符路径、`..` 逃逸、空路径 → exit 2。不做大小写折叠（在 Linux 上会把不同文件
  合并成一条）。
- **✅ 基线排序确定**：序列化按**码元字典序**排序。JS 的 `<` / `>` 比较的是 UTF-16 code unit，
  **不是 Unicode 码点**；对 BMP 字符两者一致，但不能笼统写「按码点排序」。
  排序不受 ICU/locale 影响：旧实现用 `localeCompare`，实测 `"ä"` 与 `"z"` 在 `sv_SE` / `C` 下
  顺序相反；集成测试在 `LC_ALL=C` 与 `LC_ALL=sv_SE` 下重跑 `baseline:update`，断言输出字节相同。
  写入顺序只由码元决定，未改动树上重跑必须字节幂等；报告内排序使用同一比较器。

## 基线维护

- 只允许**人工审阅后**执行 `pnpm gate:baseline`（或单 gate 的 `baseline:update`）。
- 更新前先读报告：`+` 新增必须逐条解释（为什么是长期债务，而不是本轮引入）；count 上升必须说明来源；
  `-` 是收紧。**不得把新增静默写进基线**；评审必须看 `.gate-baseline/*.json` 的 diff。
- 禁止手改 count 让门禁变绿，禁止用放宽 ignore/关闭规则代替基线更新。
- **损坏基线必须拒绝**：`check` 与 `baseline:update` 都 exit 2；update 在采集与写文件之前先校验，
  不覆盖原文件。缺失文件仍按空基线比较（首次生成前看到 FAILED 是预期）。
- **合法清零允许**：`entries: []` 是合法基线（format 当前即 0/0）；收紧到 0 是正常路径，
  不得当成损坏，也不得为「看起来在管」注入条目。
- `version` 升级必须写迁移；不得静默忽略未知 version（对应上面的结构校验）。
- 基线只存 key 与 count，不重复存 kind/file/name 字段。

## 基线快照（PR 前本地实测，2026-10-20）

| gate   | entries | 诊断总量                      | 基线 sum | 本地 gate 结果 | 原始真值                                           |
| ------ | ------: | ----------------------------- | -------: | -------------- | -------------------------------------------------- |
| knip   |    1141 | 1141（集合）                  |     1141 | OK，exit 0     | `knip --reporter json`：634 个 issue 对象 / exit 1 |
| lint   |     180 | 231（86 error / 145 warning） |      231 | OK，exit 0     | `pnpm lint` exit 1，4318 files                     |
| format |       0 | 0                             |        0 | OK，exit 0     | `pnpm fmt:check` 通过，3355 files                  |

- lint 的 180 个 key 中 145 个来自 `apps/zcode-cli`；86 条 error 全部是 `max-lines`（均在 CLI）。
- knip 的 1141 条按分类：exports 510、types 282、files 161、unlisted 92、dependencies 51、
  devDependencies 32、duplicates 12（文件级）、binaries 1。原始报告是 634 个 issue 对象；
  duplicates 原始为 37 组 / 74 成员，被折叠成 12 条文件 key，所以原始条目数与基线条目数不相等。
- 以上数字与 `OK / exit 0` 是 **PR 前本地实测**，不是远端 CI 结果；实际 CI 结果见下一节。

## CI 复验记录（PR#85 首轮）

- **失败事实**：PR#85 首轮 CI 在精确 HEAD `eff88e64` 的 `pnpm gate:knip` 步骤失败，
  run id `39398035529`；报告新增 5 个 `types` 条目（1146 vs 基线 1141），其余 gate 不受影响。
- **5 个导出名**（均为 `export` 但无跨文件消费者）：
  `apps/zcode-cli/packages/adapters/src/config/config-factory.ts` 的
  `McpServerConfigSource` / `PluginConfigScope` / `PluginConfigSources`；
  `apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts` 的
  `MarketplaceRefreshFailure` / `PluginValidationDiagnostic`。
- **零跨文件消费证据**：`git grep -n '\b<name>\b'`（排除 `*.md`）只命中两个源文件内部的声明与使用；
  唯一域外引用是 `apps/zcode-cli-rust/crates/plugins/src/list.rs` 的注释文本，不构成 TS 消费。
- **决定**：5 个类型收为文件内私有（只删除 `export` 关键词），保留 type/interface 结构、字段与返回接口；
  不改返回类型、不删逻辑。**不刷新 `.gate-baseline/knip.json`，不把该项加入忽略/允许列表。**
- **本地口径未复现**：同 HEAD 本地 `pnpm gate:knip` 为 1141（`CI=true` 亦为 1141）。
  该差异原因尚未确认，本地 `dist` 存在只是待验证假设之一，不作为结论；本次只按 CI 证据做 TS 治理修正，
  不据此改动基线或断言 CI 已通过。
- **回归约束**：`scripts/ci/ts-governance-types.test.mjs` 用 TypeScript compiler API 解析这 2 个源文件，
  断言 5 个类型仍存在且不再导出，并断言 P0-A 移除的 `PermissionDecisionResult` / `ToolScheduleItem`
  不在本地重新声明、仍走权威定义。测试只读源码，无运行时变更。
- **状态**：以上为本地验证；远端 CI 结果以 PR#85 重新运行后的实际结论为准，**本记录不宣称 CI 已通过**。

## 已知不敏感（不得声称全覆盖）

- **`max-lines`**：每个文件只出 1 条诊断，key 为 (severity, code, file) 计数。已超 400 行的文件从
  500 行涨到 900 行，count 仍是 1，棘轮不报警。因此「max-lines 已入 CI」≠「400 行被执行」：
  超限存量仍需人工拆分与复核。
- **knip `duplicates` 只做到文件级存在性**：真实 knip 6 的 JSON 把 duplicates 输出为「组 → 成员」
  的嵌套数组（实测 12 个文件 / 37 组 / 74 成员），基线沿用的是每个文件一条、`name` 为空的 key。
  后果：
  - 同一文件**新增重复组或新增成员不会**被检出（key 不变，count 恒为 1）；
  - 只有「某个文件第一次出现 duplicates」会新增 key 并阻断（即新增文件 key 可检出）。

  此前文档写过「新增成员可检出」，那与实测不符，已纠正。为保持既有 1141 条基线集合不变，本轮
  **不重做成员级 key、不刷新基线**：这是**明确接受的残余限制**，不是已治理项，不得当作已覆盖。
  若要覆盖成员维度，需要单独的基线迁移——key 形状变化会让现有 12 条 duplicates key 全部失效。

- **knip 集合语义**：key 是 (kind, file, name) 的集合；`exports` / `types` 等同一符号只算 1 条，
  `duplicates` 再折叠到文件级（见上一条）。代价是符号/成员层面的增减粒度更粗。
- **lint 计数语义**：只对 (severity, code, file) 计数，规则换位置、message 变化不影响门禁 ——
  这是刻意的稳定性取舍。
- **format 只覆盖根 oxfmt 的扫描范围**：`apps/zcode-cli` 是版本边界，不在根门禁内
  （见 `formatting-gate.md`）。

## 测试与验收

**✅ 已实现**（本地实测 50 个用例全部通过）：

- `scripts/ci/gate-ratchet.test.mjs`：**36 个单测**，覆盖 key 编解码、knip/lint/format 解析、
  路径归一、比较、基线与报告序列化、二进制定位、`isMainModule` 纯函数。
- `scripts/ci/gate-ratchet.integration.test.mjs`：**14 个端到端用例**，全部走真实子进程。
- CI 的 `node --test --test-isolation=none scripts/ci/*.test.mjs` 通配会自动命中两个文件。
- `scripts/ci/desktop-workflow.test.mjs` 解析真实 `.github/workflows/desktop.yml`，必须断言 `checks` 里是
  精确的 `pnpm gate:lint` / `gate:format` / `gate:knip` 三条步骤，且不得带 `continue-on-error`、
  `|| true` 或 `exit 0` 包装，步骤 `if` 只取 setup 成功与未取消；原始 `pnpm lint` / `pnpm fmt:check`
  对存量债务必然失败，不能作为 CI 替代。

集成测试的隔离与场景（均已实现）：

- **隔离**：每个用例 `mkdtemp` 自建临时目录并以其为 `cwd`；不读写仓库基线、不共享 cwd/env
  （CI 使用 `--test-isolation=none`，同进程内不得依赖用例顺序）。
- **假工具布局**：`<tmp>/package.json` + `node_modules/<pkg>/package.json`（`main` 指向
  `dist/index.js`）+ `node_modules/<pkg>/dist/index.js` + `node_modules/<pkg>/bin/<bin>`。
  必须保留 `dist/` 这一层：`resolveToolBin` 从入口所在目录回推 `../bin/<bin>`，
  写成包根会解析到 `node_modules/bin/*`。假 bin 是普通 node 脚本，按用例打印 stdout/stderr
  并指定退出码或信号。
- **真入口**：用 `spawnSync` 以真实入口启动：
  `spawnSync(process.execPath, [<repo>/scripts/ci/gate-ratchet.mjs, gate, command], { cwd: <tmp> })`。
  断言 stdout 报告与退出码；另有真实 oxfmt 的隔离 smoke（软链仓库 `node_modules/oxfmt`，最便宜的 smoke）。
- 覆盖场景：
  1. 假工具 exit 2/3 或信号 → gate exit 2，stderr 含工具名与退出码，且不写基线。
  2. lint `number_of_files: 0` 或缺失 → exit 2。
  3. 输出无法理解：空 stdout、非 JSON、缺 `diagnostics`/`issues` → exit 2。
  4. 基线流程：缺失基线 → check exit 1；`baseline:update` 生成按码元排序的文件 → exit 0；
     再次 check → exit 0；制造 +1 → exit 1；再减少 → exit 0 且有收紧提示；合法清零允许。
  5. 损坏基线：非法 JSON、`version≠1`、`entries` 非数组、key 段数/首段错误、count 为 0/负数/非整数、
     重复 key → check 与 update 都 exit 2，且 update 不覆盖原文件。
  6. 排序幂等：`LC_ALL=C` 与 `LC_ALL=sv_SE` 下，同一 entries 的 `baseline:update` 输出字节相同。
  7. 入口守卫：把入口与相邻 `gate-ratchet-core.mjs` 一起复制到含空格/中文/百分号的临时目录后
     仍能执行；`import` 模块不执行 main；纯函数另测 URL 编码路径与宿主平台语义。
  8. 参数错误：未知 gate、未知命令、缺参数 → exit 2。
  9. knip 零扫描（已知残留）：空 fixture 下假 knip 输出 `{"issues":[]}` + exit 0 → gate exit 0；
     测试明确记录「这与真正干净无法区分」，不得把 exit 0 误读成已检测零扫描。
  10. knip 未知分类 / 缺 `file` / 坏条目 → exit 2；`owners` 元字段不被误拒；`nsExports` 新增可检出。
  11. lint 非法诊断字段 → exit 2，不产生幽灵 key。
  12. Windows 风格路径归一为正斜杠、保留大小写。
- **验收**：两条测试命令全绿（36 + 14 = 50）；`pnpm gate:knip` / `gate:lint` / `gate:format`
  均 OK；`pnpm fmt:check` 覆盖新文件后仍通过。以上均为**本地验证**；远端 CI 状态见「CI 复验记录」，
  不得把本地结果写成 CI 通过。

## 相关 spec

- `formatting-gate.md`：oxfmt 忽略清单三类与 `.prettierignore` 版本边界（本 spec 不重复）。
- `upstream-code-review-parity.md`：这些门禁在上游 code review 报告里的对账与剩余工单。
- `AGENTS.md`：命令表，以及「原始真值」与「棘轮门禁」的区别。
