# S6：ToolSearch（Rust）与 S3 路径附件冷恢复（Rust）

父规格：`.agents/specs/upstream-3.16-sync.md`「S6：ToolSearch 所有者与协议」「附件」。
上游来源 `3c5b2276`（3.16.2）。权威语义以
`apps/zcode-cli/docs/design/v2/tool/19-tool-search.md`、`packages/contracts/src/tools/tool-search.ts`、
`packages/contracts/src/tools/deferred-tool-call.ts`、`packages/core/src/tool/search/{search,exposure,history,description,local-projection}.ts`、
`packages/core/src/tool/deferred-call.ts`、`packages/core/src/agent/{session-history-hydrator,file-part-hydration}.ts`
与真实编码器为准。TS 侧的 core/runtime 接线由另一 worker 负责；本切片只改 Rust（`apps/zcode-cli-rust`）
与本节规格。模型侧（能力、beta、HTTP `defer_loading`/`tool_name`、`ModelRequestOptions`）已由 S4 交付，
本切片不重复实现、不改 `crates/model`。

## 所有权与事件顺序

```text
启动偏好（CLI --toolsearch-mode / Host 启动参数，缺省 off）→ RuntimeOptions.tool_search.mode
  → 每步请求准备（作用域/权限/allowlist 过滤后的完整候选目录）
      → 目录分类（常驻 / deferred / MCP alwaysLoad）+ 已发现集（真实历史引用 + 有效 compact 检查点）
      → Native / Local / Off 暴露 + 历史引用投影（引用块、Local 展开、公告隐藏、包装调用还原）
  → provider 编码（model crate，S4）
  → 同一 executor：DeferredToolCall 解包 → 目标工具既有权限/Hook/执行/结果/turn-stop
  → 目标工具 part 提交（tool=目标名，metadata.modelCallWrapper）+ 结果 modelContent
  → 下一请求重新投影；正常工具批次提交增量公告；compact 成功写发现检查点并重建公告
```

单一可变事实：`Session.messages` + `Session.state`（`ContextState`）。ToolSearch 不新增数据库列、
不新增跨请求缓存、不新增第二队列/执行器/公告状态。请求投影只派生，不改主历史。

不变量：

1. 候选目录只来自 `ToolPort::scoped_definitions` 等既有入口，随后经 Model/可见性/allowlist/主子作用域
   过滤；ToolSearch 不扩张权限，不注册不存在的工具。
2. 无 deferred、或控制入口（ToolSearch / Local 的 DeferredToolCall）不在目录时退化为全目录并记录原因；
   不得静默丢工具。Local 全部提升后控制入口仍保留。
3. 发现集只来自已提交的成功工具结果里的严格 `{type:"tool_reference",toolName}` 引用与成功 compact
   检查点；失败/取消/未提交结果不产生发现。原始历史保存真实引用，不保存 schema 快照。
4. Native 只发送常驻 + 已发现 deferred schema（后者 `deferLoading: true`）；Local 只发送常驻 + 两个控制
   入口，目标 schema 在真实结果位置展开；Off 发送全目录。非 Anthropic 不发 beta/`defer_loading`/引用。
5. `ToolSearch`/`DeferredToolCall` 是控制入口：不是 JSON 搜索工具；`ToolSearch` 只读、并发安全。
   `Glob`/`Grep` 的 `tools/src/tool_search.rs` 是文件搜索实现，与本切片无关，不改名不复用。
   该只读/免审批事实必须来自真实 TS 注册 metadata 的生成资产；在 build 和 plan 下都能搜索，不能落入 unknown-tool 的 Ask/Deny。
6. `DeferredToolCall` 入参严格 `{name, input}`；只接受当前请求允许的 client-executed deferred 工具。
   常驻/alwaysLoad/控制工具/provider 原生工具返回普通工具错误且不执行目标 Hook/审批/handler。
   包装解包后同一 callID 复用普通调用的权限、Hook、超时、取消、结果格式、媒体与 turn-stop。
   已解包调用的 live 行/事件、持久 part、冷恢复均以目标名与完整 input 定稿；仅模型出口还原包装名。
   无效包装只保留包装失败，不能执行或伪造目标事件。
7. 公告是派生提醒：正文 + 增量 metadata 一次提交（`ModelOnlyNotice`），冷恢复原位还原；纯 Continue
   不收集；成功 compact 才重建；关闭模式只在请求投影隐藏，不删存储事实。旧会话无公告不回填。
8. `completed/error` 的 `state.metadata.modelContent` 兼容旧字符串与严格 text/reference 数组；坏 metadata
   不丢 display/媒体布局。冷恢复优先合法 `modelContent`，否则媒体布局/`output`/`error`。
9. 搜索/输入与上游实际执行 schema 一致：UTF-8 大小写转换不得产生字节切片 panic；JS 正则词边界按同一语义，
   `max_results` 的缺省/数字/负数/小数/null、额外键和 select 换行分别用差分场景验证，不擅自收紧 zod 非 strict 行为。
   Local loaded/already-loaded 名单按顺序去重；Off 在按 role 分流之前隐藏公告；所有无工具辅助请求也必须先投影旧引用。
10. MCP `alwaysLoad` 来自 server 配置与工具 `_meta["anthropic/alwaysLoad"]`（strict boolean，保留 false），
    `searchHint` 来自 `_meta["anthropic/searchHint"]`。只影响 schema 曝光，不改变连接/鉴权/权限/就绪。

## Rust 落点

- `crates/domain/src/tool_search/`（纯函数，无 IO）
  - `mod.rs`：名字/常量、`Mode{auto,native,local,off}`、`ResolvedMode`、`resolve_mode`
    （native 需 `protocol_supported`；auto 的 Coding Plan 判定读 `ToolSearchCapability::default_enabled`；
    local 需 `supportsToolCall`）、`Candidate`、`Metadata`、内置常驻/deferred 名单与 `searchHint`。
  - `search.rs`：`search_tools(query, catalog, max_results)`，含 `select:`、精确名、`mcp__` 前缀、
    关键词、`+required` 交集、分词/权重/稳定排序/去重，与上游逐条一致。
  - `exposure.rs`：`resolve_catalog` + `build_exposure`（tools/messages/enabled/mode/reason/discovered），
    `build_announcement`（增量 metadata：added/removed/readded，30 名称阈值与 MCP 分组文案）。
  - `projection.rs`：引用投影（Native 保留 + `Tool loaded.`；Local `<functions>` 展开 +
    Loaded/已加载提醒；Off 移除 + 占位）、包装调用还原为 `DeferredToolCall`。
  - `discovery.rs`：历史发现扫描、公告增量合并、严格 modelContent 校验。
- `crates/tools/src/tool_search_meta.rs`：`ToolSearch`/`DeferredToolCall` 定义与 schema
  （模型侧 `required: [query, max_results]`，runtime 缺省 5）。`tool_definitions.rs` 注册两个控制入口。
  `mcp_config.rs` 解析 server `alwaysLoad`；`mcp_hub_bindings.rs` 读取 `_meta` 元数据并经
  `ToolPort::tool_search_metadata` 暴露。控制入口 schema/description 与内置常驻/deferred 元数据
  不再手写：`scripts/generate-zcode-cli-rust-tool-schemas.mjs` 从真实注册的 `builtInTools`、
  `toolSearchToolEntry`、`deferredToolCallEntry` 和 contracts 生成 `tool_schemas.json`、
  `tool_search_controls.json`、`tool_search_metadata.json`；`scripts/generate-zcode-cli-rust-system-reminders.mjs`
  从 `SYSTEM_REMINDER_SOURCES` 生成 `schema/system-reminders.json`。生成器进入
  `check:zcode-cli-rust-contract-assets` / `generate:zcode-cli-rust-contract-assets`。
- `crates/app-server`：`--surface desktop` 的 App Server 在 `session/create` / `session/resume`
  前通过既有反向 RPC `session/requestRuntimePreferences`（scope `runtime-materialization`）读取
  Host App 设置，并把 `toolSearchMode` 写入既有 `runtimeConfig.toolSearch.mode`；显式 CLI
  `--toolsearch-mode` 仍优先，旧 Host 缺字段/不支持该 RPC 时回退 Off。不新增 env、第二配置路径
  或逐轮读取；热 resume 保持已固定值，冷 resume 使用最新值。
- `src/args.rs`（app-server）的 `--toolsearch-mode` 区分「未传」与显式值，供上述优先级判定；
  `crates/headless/src/args.rs`（prompt/TUI）保持独立 CLI 缺省 Off。
- `crates/core/src/app/tool_search.rs`：请求准备（mode/能力/候选目录/历史 → Exposure）、
  `ToolSearch` 执行（enabled 校验 → 搜索 → 引用 `model_content`）、公告提交、compact 检查点。
- `agent_loop.rs`：每步一次准备，请求用投影后的 messages/tools/options；工具批次后提交公告。
  compact 摘要请求仍使用未裁剪候选目录（保留既有阈值策略）；成功 compact 写入发现检查点并重建公告。
- `tool_execution.rs`：`DeferredToolCall` 解包（无效即普通错误，零目标执行）；`ToolSearch` 处理分支。
- `node_journal`：part 保存 `tool=目标名` + `metadata.modelCallWrapper`；成功/失败结果写
  `metadata.modelContent`（字符串或严格数组）并保留 display。`node_history` 冷恢复按同一优先级重建。
- `session_runtime.rs`：`RuntimeOptions.tool_search_mode`；`Engine::with_tool_search_mode`；
  `src/args.rs`（app-server）、`crates/headless/src/args.rs`（prompt/TUI）新增
  `--toolsearch-mode auto|native|local|off`（缺省 off，非法值报错，不保留旧 `--enable-toolsearch` 别名）。

### S3：路径附件首发说明冷恢复（Rust）

`crates/domain/src/node_journal/files_local.rs` 的 `local_reference` 与 `local_failed` 在
`storageKind: "local_ref"` 时把首发说明原文写入 `pathReferenceText`；`node_history/attachment.rs`
的 `file_block` 优先原文返回该字段（byte-identical），字段缺失（旧行）继续既有占位/预览逻辑。
不改 TS、不改数据库列、不读真实用户 fixture。

## 验收

- Rust 单测：模式解析矩阵、搜索评分/`select:`/别名/MCP 短名/`+required`、暴露决策
  （native/local/off、无 deferred、控制入口缺失、Local 提升）、引用投影（多引用/混合文本/Hook 文本/
  失效引用/占位/包装还原）、公告增量与 30 名称阈值、modelContent 严格校验。
- `pnpm -C apps/zcode-cli-rust` 侧：`cargo test -p zcode-cli-domain`、`cargo test -p zcode-cli-tools`、
  `cargo test -p zcode-cli-core --lib`、`cargo fmt --check`、`cargo clippy --workspace --all-targets`、
  真实回环 HTTP 的请求体断言沿用 S4 的 `model/src/tool_search_wire_tests.rs`。
- 真实 SQLite 冷恢复：持久化 `modelContent` 引用 + 公告增量 → 关库重开 → 下一请求引用/公告一致
  （由既有 node_storage/runtime_consistency 用例扩展，非 mock 名称断言）。

## 参数校验提示的后续设计（实现前冻结）

Rust 不新增通用 inputSchema 验证器。现有 JSON 入参解码、各工具参数读取/领域 parser 与 MCP InvalidParams
仍各自负责原来的验证，只把确定的输入失败通过严格 `InputValidationError` 诊断契约传回既有 executor。
executor 不重验 schema、不按异常文本猜类型，仅在当前 deferred 且未发现工具的确定输入失败上追加上游搜索指引；
普通执行/网络/权限错误不追加。保持 callID/目标事件/原始入参、Hook、权限、错误主因和取消语义。
测试证明「错误参数 → 明确提示 → ToolSearch → 正确参数执行一次」且无副作用重复；本段为设计，不冒充已执行证据。

## 剩余缺口（本轮如实记录）

1. 生成器已闭合：`generate-zcode-cli-rust-tool-schemas.mjs` 从真实 `builtInTools` /
   `toolSearchToolEntry` / `deferredToolCallEntry` / contracts 生成 `tool_schemas.json`、
   `tool_search_descriptions.json`、`tool_search_metadata.json`；
   `generate-zcode-cli-rust-system-reminders.mjs` 从 `SYSTEM_REMINDER_SOURCES` 生成
   `schema/system-reminders.json`。两项 `--check` 均为确定性通过。
2. TS core/runtime 接线（`packages/core/src/tool/search` 等）为另一 worker 的未提交改动；
   两侧请求快照与公告时序需在主会话合并后做一次交叉验证。
3. Native 成功提示已按上游放在连续 tool_result 批次之外：每条成功且投影后仍有有效引用的
   搜索结果派生一条 `{"role":"user","content":"Tool loaded."}`，整批结果之后按 callID 顺序追加；
   不拆开并行/连续 tool 结果，不写 canonical 历史。Local 仍只在结果内给出加载/已加载提醒。
4. 真实引擎 E2E：新增 `tests/tool_search_e2e.rs`，使用真实 `Engine` + 回环 HTTP + 临时
   `NodeStore` SQLite，覆盖 native/local/off、权限/取消/resume、下一请求引用、成功 compact
   发现检查点、Local 提升与公告冷恢复；不使用模型/工具 mock 名称断言。
5. 未运行 Windows/macOS 或真实 provider；本轮证据限于 Linux、Rust 单测/集成与真实回环 HTTP。
6. **P2-6「未发现 deferred 工具参数校验失败 → 先 select 搜索」：Rust 已按冻结设计闭合。**
   `domain::input_validation::InputValidationError` 经 `core-api` 公开错误边界传递；既有 Core JSON
   解码、工具参数读取、Todo/plan parser、Web 验证与 MCP `tools/call` 的数值 `-32602` 各自标记
   确定入参失败，保留原始 cause 与检查条件。当前 Rust 无 Cron handler/parser，不新增或伪造其能力。
   executor 只检查严格类型与当前请求 deferred/未发现事实，不校验 schema、不匹配异常文案；
   原错误后逐字追加 `3c5b2276` 实际 `call-runner.ts` 的解释、select 指引、当前 schema 与 Local 包装提示。
   `原 decoder/parser → typed error → 既有 executor 错误出口 → 同一 ToolDone/error → 模型与 UI part`；
   没有第二执行器/队列/IO domain。MCP InvalidParams 是已收到的参数拒绝，不关闭健康连接；其它错误
   仍走既有清理路径，不自动重连或重放，确保同轮加载后的有效重试只产生一次实际副作用。
   实证：`tests/tool_input_guidance/{e2e,mcp}.rs` 的真实 Engine + 回环模型 + SQLite + stdio MCP，
   Native/Local 均完成「错误参数 → 完整提示 → ToolSearch → 正确重试」，真实 Todo owner 一次成功提交、
   MCP effect 文件恰好一行；同一 callID、目标 part/原始 input、Pre/Failure/Post Hook 与原始失败原因
   均有断言，错误 part 持久保存纠错提示供 UI 消费。已发现/Off/常驻/无效包装、权限/网络策略/exit 1、
   MCP 断连/非 JSON 响应/internal/isError 均无提示。Core 契约测试还证明 schema 不匹配但 handler
   接受时照常执行，未增加通用验证。`cargo test --locked --workspace`：900 passed / 0 failed；
   ToolSearch 真实引擎测试 13 项通过；fmt 与 16 crate 边界通过（按换行计数的 Rust 源文件均 ≤400 行）。
   此证据仅限 Linux 受控回环和持久 UI 业务投影，不表述为 Desktop/手机 UI 或真实 provider 验收。

## 本轮验证（2026-10-23，Linux）

- `cargo test --workspace`：857 passed / 0 failed（56 个 test binary）；
  `cargo clippy --workspace --all-targets`：0 warning / 0 error；`cargo fmt --check` 通过。
- `node scripts/check-zcode-cli-rust-boundaries.mjs`：16 crate 边界通过，所有 Rust 源文件 ≤400 行。
- `tests/tool_search_e2e.rs`（4 项）使用真实 `Engine` + 回环 HTTP + 临时 `NodeStore`：
  native 引用/批次外提示/冷恢复公告一次；local 展开、常驻目标拒绝零执行、compact 发现检查点
  提升、冷恢复仍直接暴露；off 冷恢复移除控制入口/引用；stop 取消挂起请求后无发现。
- 真实 release binary（`target/release/zcode-cli-rust`）进程级回环验证：`--surface desktop`
  经反向 `session/requestRuntimePreferences` 注入 native/local/off，三模式首请求目录、
  native 批次外 `Tool loaded.`、local `<functions>`、off 全目录与冷恢复下一请求均符合预期；
  临时 HOME/XDG/data-dir/DB，无用户数据。
- 根目录 `pnpm typecheck`、`pnpm lint`（0/0）、`pnpm fmt:check` 通过；生成器 `--check` 通过。
- 未运行 Windows/macOS、真实 provider、Desktop/手机 UI 或真实远端 workspace；不将本轮
  受控回环结果表述为完整跨平台/真实模型验收。
