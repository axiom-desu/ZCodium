# 退役当前 lint 存量：真实修复而非改门禁

## 范围

用户在 `59ddf0bc` 上要求同时修复 ACK 等待与 lint 存量。本 spec 只管 lint；ACK 行为见 `cli-rust-tui-responsive-operations.md`。
当前 raw oxlint 扫描 4327 文件，86 errors（全部 TS CLI max-lines）、145 warnings，共 231 诊断、180 指纹。
85 个自有/适配代码报错文件约 66,650 有效行；另 1 个官方 lucide 发布资产有 17,790 有效行。不能把这当几十个自动格式修复。

## 不变量

- 目标是实际 `pnpm lint` 无 error/warning；保持 400 有效行规则，不新增 disable、ignore、阈值豁免或放宽基线。
- 自有代码按明确职责提取：类型/协议数据、纯转换、IO adapter、projection、会话/工具协调分别归属，保持原公开入口与类型。
- 不以 barrel 行数替代实际拆分，不将巨大类型改 any，不把 broad this 混入无限 helper 模块声称已完成 runtime 解耦。
  本次是保守结构治理，不宣称解决上游 P1-A 的完整 runtime 架构重设计。
- 每个新文件也必须满足现行 max-lines；不能把一个超长文件搬到另一个超长文件，不能通过压缩自有代码行数规避。
- mutable state、event 顺序、admission、队列/权限/持久化、owner/lease、workspace identity、恢复/回放语义不变。
  特别是 ProductProjection 与运行时只保留原状态 owner，提取的构建器不持有第二份事实。
- 旧路径和包公开 export 保持；跨包只用公开入口。新增内部 helper 不为消 warning 假增 export 或作 no-op 消费。
- 未使用项按语义修复：有副作用的 initializer/调用必须保留；不随意删公开参数、改变函数 arity 或 protocol/schema 字段。
- 不安全 finally/可选链先写行为测试，保持原始异常优先、cleanup 失败在原操作成功时才传播，覆盖 falsy thrown values。
- 不读/格式化/删除 logs/ 或真实用户数据，不恢复已移除内部模块/依赖，不升级格式器。

## 官方第三方资产

lucide 1.17.0 是已校验 npm 发布物，不手工改写/压行或拆 UMD 闭包。
优先核实同一锁定发布 archive 是否包含官方 minified UMD：若存在，可改用原样发布的 minified 资产，
保留同一版本、tarball integrity、完整许可证，并更新 manifest/打包清单/fixture/hash/来源与 notices。
需证明导出 API/图标定义与旧发布资产一致，并跑真实 gen-ui 离线/runtime 验收；不能使用不同版本或本地自压缩冒充官方原文。
若同版无合法替代发布资产，不擅自增加 ignore 或网络构建依赖；先报告具体证据再对齐资产管线方案。

## 外部可选工具与新增辅助模块

PDF skill 已有按需使用的 Playwright/pdf-lib 加载与缺失提示，不能为消 knip 回归偷偷安装到生产依赖，或加 ignoreDependencies。
声明已有外部工具接口时，Root 安装/lock-only 检查必须证明不自动拉入这些包或改变既有锁定版本。
已实测 pnpm 10.33.2 在 root autoInstallPeers:true 时会为工作区自身安装 optional peers，不能直接加在 pdf-plugin 工作区清单。
工具本身是独立执行的 skill CLI，可在其 scripts 根添加真实 standalone tool manifest（CommonJS、peer requirements），不纳入 pnpm workspace；
静态分析仅精确登记该真实工具 project/入口。这样 Root 安装图不变，工具依赖声明与手动按需安装语义一致，不靠 ignoreDependencies 或改写 require 隐藏依赖。
Knip 已验证支持这一独立 project。工具入口相对应用仍是可选、不随应用安装依赖；独立工具 project 中使用普通 peer requirements 声明其环境前提。
用户只有显式进入该独立 project 执行安装时才会拉取 peer；Root workspace/lock/importer 不变。不要再将它们标记 optional peer（Knip 将已引用 optional peer 视为不一致），也不以新基线收录这类诊断。
若后续改变工具安装语义，须单独评审，不扩 ignore/基线。
新增 skill helper 必须进入真实 filesystem/SEA 资产种子及离线相对 import 闭包验收；测试不冒充原生产依赖。
新增拆分文件中的内部类型/函数只在确有跨文件消费时导出；既有公开入口保持，真实死模块必须先查静态、动态路由与副作用再删除。

### PDF 渲染工具（已落地）

`apps/zcode-cli/packages/pdf-plugin/skills/pdf/scripts/` 现在是真实独立工具包 `@zcode/pdf-render-tool`（`private`、`type: commonjs`、
`peerDependencies` = `pdf-lib` / `playwright` / `playwright-core`，不标记 optional；这些是显式选择该工具环境后的前提，不是应用依赖）。
它不在 `pnpm-workspace.yaml` 的 glob 内（已实测 `pnpm -r ls` 仍为 48 个 project，`pnpm-lock.yaml` 无该目录 importer，
`pnpm install --lockfile-only --offline --ignore-scripts` 前后 lock diff 为 0），Node 解析路径不变。
`knip.json` 只按这个真实 project 登记 3 个 CLI 入口（`html2pdf-next.js` / `html2poster.js` / `cover_validate.js`），
父插件 workspace 不再登记 PDF 脚本入口（原写法把脚本错误 scope 到父 workspace，产生 2 个 unlisted + 3 个 unused-file 指纹）。
`skills/pdf/scripts/package.json` 已进 `BUILTIN_PLUGIN_SEED_PATHS["pdf-plugin"]`；回归锁在 `scripts/ci/pdf-render-tool-standalone.test.mjs`
（manifest 形状、workspace/lockfile 归属、knip 归属与无 unlisted、种子清单、实际 `knip --workspace` 结果）。

knip 6.4.1 的 `DependencyDeputy` 对「被引用且已声明为 optional peer」的依赖无条件产出 `optionalPeerDependencies` 告警
（源码：referenced 且不在 dependencies/devDependencies 即上报），workspace 级 config 不支持 include/exclude/rules，
因此不采用“标记 optional 后把 3 条告警收进基线”的方案。
独立工具 project 使用普通 peer requirements，实际运行仍保留原按需加载/缺失提示；用户明确进入工具目录安装时才提供工具环境。
Root 不安装该 project 或这些 peer，现有 workspace 锁图不变，且不新增基线/ignore。

## 实施分片

相互独立的包内改动并行，保持原导出面以免交叉任务互相依赖：

1. 非 max-lines 文件上的普通 warning（UI、desktop、services、scripts 与 CLI 小文件）；正确性 warning 的单独行为测试。
2. contracts 的纯类型/schema 与 runtime interface、CLI/debug/TS TUI 的职责提取。
3. core runtime methods 与 runtime helpers；core tool/services 各自保持原 orchestration owner。
4. adapters 的 model/storage/mcp/fs/config/plugins 各域内部提取。
5. bootstrap app、旧 protocol、v4 projection/gateway 各自保持唯一 owner、原事件次序与缓存失效。
6. 官方 vendor 原样资产选择及全部分发/来源接线。

受控 TS 模块当前 zcode-cli/ui/session 的 context 中部分为 unmanaged；不伪造它们已被完整架构治理。
每个 worker 在自身 scope 先给实际接缝、补对应测试，再实现；不得顺带改协议或刷新基线。

## 验收

- 原 raw 诊断清单用作逐项对账；不能只看总数下降，必须核对移动文件的新诊断与新 lint 关闭标记。
- 原 public export surface、运行时 receiver/this、事件先后顺序与 SQL migration 文本保持；加行为/结构回归锁定关键边界。
- 各当前 package.json 提供的 typecheck/test 实际执行；无 test script 的 CLI/TUI 使用现有实际测试与真实 PTY，不虚构统一入口。
- root typecheck 与 `pnpm lint`（目标 0/0）、三 gate、architecture、Rust/Node contract assets 检查；跨包改动需对应全部包 typecheck/tests。
- 需要 UI/交互改变时补真实 E2E，不用静态快照代替真实 admission 或清理效果。
- 基线仅在原始结果验证、独立 review 后可收紧删除已消除指纹；不能增加条目/count 或以更新基线“通过”。
- 精确 PR HEAD CI 通过后才 guarded rebase merge；与 ACK 修复分账，不以某一半通过宣称两半全部清零。
