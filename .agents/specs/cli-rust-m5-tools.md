# M5 Rust tools：真实差分验收

## 范围与所有者

M5 范围是 Rust `crates/tools` 对齐本仓库 TS CLI `apps/zcode-cli/packages/core/src/tool/handlers` 的工具行为；本批先验收本地临时 workspace 内 Read/Write/Edit/Glob/Grep 的一个可重复差分切片。当前公开导出的 `builtInTools` 中的 ToolEntry + 默认 NodeFileSystemAdapter（Grep 优先 bundled ripgrep，保留其现有 fallback）是 oracle 所有者，Rust `workspace_tools` 是被测实现；两者只操作独立临时目录，不接触真实用户文件、provider 凭据或网络。

工具调用不含 permission executor / hooks：该边界仍由 TS executor 的权限与 hook 链拥有。本次不以 Rust 自测替代权限差分，也不宣称 hooks/permission 已验收。后续需由真实 TS permission service/hook runner 与 Rust 对应决策实现逐项对照。

## 接口与顺序

```text
临时 fixture 建立 → TS handler / Node adapter 计算 oracle
                    → 同输入送 Rust examples/tool_fixture
                    → 规范化动态字段后逐项比较 → 清理临时目录
```

TS handler 接受 workspace 绝对路径并由 `ToolExecutionContext` 提供 `workingDirectory`、`workspaceRoot`、`fileSystemPort`、调用级 `readFileState`。Rust fixture 接受 cwd 和一行一调用 JSON。测试 driver 不得写入仓库工作区；不支持网络工具。

## 本批验收场景

- Read 文本、CRLF/BOM、空文件、超出行数的分页：比较结构化文本、起始行、行数、总行数、截断标记及模型文本。
- Edit 成功、replace_all、未先 Read、重复匹配、匹配不存在、无改动、缺失文件：比较结果状态、稳定错误文本及成功输出字段/模型文本，最后逐文件比较字节。Write 新建（含父目录）、已 Read 后覆盖、未 Read 拒绝；拒绝时也必须不改变文件。
- Glob 匹配/无匹配/限定目录/空 pattern/缺失目录，比较除 durationMs 外结构化输出及模型文本。用确定 mtime 保留顺序验证，不排序掩盖错误。
- Grep 默认文件模式、content/count、大小写、glob、单文件、分页（`head_limit`/`offset`/offset 越界/`head_limit: 0`）、无匹配、空 pattern/坏 regex/缺失路径，以及编码边界（文件起始 UTF-8 BOM、CRLF、单独 CR、含非法 UTF-8 的行文本）与 `-C`/`-B`/`-A`/`context` 优先级组合（含显式 `context: 0`）。比较除 durationMs 外所有结构化输出，并按 TS `formatGrepModelContent` 比较 files/content/count 三态的模型文本（`Found N file(s)`、`Found N total occurrence(s) across M file(s).`、`[Showing results with pagination = ...]`）。本批仍不覆盖 multiline、NUL/二进制文件的显式路径、UTF-16（LE/BE）BOM 文本、多文件 content/count 的行顺序和大输出（沿用本地 20KB 上限）。
- 两侧传相同相对参数（文件工具都支持 workingDirectory 解析）；只规范化两份临时 workspace 的绝对前缀、耗时及显式不在此切片的 telemetry。失败消息仅对有共同稳定契约的错误比较全文或片段；regex/schema 库错误只比较失败分类，不将不同库文案冒充 parity。
- TS 从公开 ToolEntry 集合选择允许的五个工具，不复制 handler 或 schema；入口不允许越出真实系统临时 workspace（包含 symlink 校验），非白名单工具在执行前拒绝。直接调用 handler，不调用 permission executor。
- oracle `--check` 每次重新运行 TS handler 获取结果，不能只检查静态 fixture 或硬编码期望输出。差分断言以实时 TS 结果为基准。
- Rust `cargo test` 仍可作为局部自测，但不作为本批差分证据。

## 已确认差异与修复规则

实时 oracle 已确认：Rust Read 去掉 BOM 而当前 TS range reader 保留；Rust Write/Edit 结构化 filePath 返回绝对路径而 TS 保留输入；Rust 接受空搜索 pattern；Rust Grep 文件结果未按 mtime 排序、默认分页字段多余。修复仅在 tools adapter：保留 Read BOM，结果路径保留输入（display 仍用真实路径），搜索 trim 后拒绝空 pattern；Grep 文件模式先排序再分页，分页不影响总匹配计数，只有确实截断/正 offset 才输出分页字段。另外确认 TS empty Read 将首行空结果规范化为 numLines/totalLines=1，模型提醒亦按该值生成；TS diff 提供 3 行上下文，Write create 的 structuredPatch 为空。修复空文本统计、共享单区间 patch 的三行上下文和 Write create 输出；多区间 diff 算法仍未验收。实时 oracle 以 `replace_all` 跨区间替换确认该分歧仍在：TS/jsdiff 按 3 行上下文生成多个 hunk，Rust 仍输出单个合并 hunk，本批不改动该算法。保持本地既有 20KB/文件大小限制，不宣称大输出 parity。

TS core 根 barrel 在原生 tsx ESM 导入时因 `ToolExecutor` type 被作为值 re-export 报错；oracle 使用该根公开 re-export 所指向的 `tool/handlers/index.ts` 的真实 `builtInTools` 集合。adapter 使用公开 fs 入口。不得为此次验收修改 root barrel 或恢复依赖。

实时 oracle 进一步确认 Grep：Rust 未实现 TS 的模型文案（files 的文件数前缀、count 的汇总摘要、content 的 `[Showing results with pagination = ...]`，以及 files 内联的 `limit:`/`offset:`）；Rust 保留文件起始 UTF-8 BOM 而 bundled ripgrep 会剥离，导致 `^` 锚定首行与行文本不同；含非法 UTF-8 的行在 ripgrep JSON 只给 `bytes` 字段，TS adapter 读不到 `text` 时输出空文本，Rust 却输出 lossy 文本。修复在 `tool_search`：剥离文件起始 BOM；按 raw 行字节判定非 UTF-8 行并在 content/context 输出空文本；模型文案由结构化输出字段推导，复用 TS 三模式与分页语义，替换原先的 `(Results truncated...)` 私有后缀。多文件 content/count 的行顺序由 ripgrep 遍历顺序决定，本机实时 TS 呈字典序但未作为稳定契约；multiline 的 `numMatches`/跨行 entry 与 NUL 二进制文件的显式路径行为仍未对齐，留待后续。

实时 oracle 进一步确认 Grep 上下文参数优先级：TS `grep.ts` 先算 `contextLines = parsed.context ?? parsed["-C"]`，再由 fs adapter 的 `addRipgrepContextArgs` 在 `contextLines !== undefined` 时只向 ripgrep 传 `-C` 并提前返回，`-B`/`-A`（即使同时给出）被忽略；只有没有 `context`/`-C` 时才分别传 `-B`/`-A`。注意 oracle 默认走 bundled ripgrep 的 rg JSON 解析路径（`parseRipgrepJsonOutput`），不是 `searchTextWithJavaScript` fallback；后者在 `context` 与 `-B`/`-A` 同时存在时会用 `-B`/`-A` 覆盖 `context`。Rust 原实现以 `-B`/`-A` 覆盖 `context`，与 rg 路径不一致。修复只在 `tool_search`：`context`/`-C` 存在时（含显式 0，`??` 只跳过 null/undefined）before/after 都取该值并忽略 `-B`/`-A`，否则沿用 `-B`/`-A`；Rust 单测覆盖该优先级与 `grep_raw_lines`/`grep_model` 的本地自测，但并不据此宣称差分已验收。

UTF-16（LE/BE）BOM 文本本轮不验收且两侧不一致：TS Grep 交给 bundled ripgrep，由 ripgrep 按 BOM 嗅探并转码后搜索；Rust Grep 直接按字节读文件并以 NUL 判定二进制整体跳过，UTF-16LE 内容含 NUL 因而无匹配（本机实时 oracle 对 `\ufeffalpha\nbeta\n` 的 UTF-16LE 文件可命中 `beta`，Rust 返回空）。该行为与 NUL/二进制显式路径同属后续，本轮不改动。

## 验收与边界

命令：`node --import tsx --test scripts/tests/cli-rust-m5-tools.test.mjs`。并执行 `cargo test --locked --manifest-path apps/zcode-cli-rust/Cargo.toml -p zcode-cli-rust --example tool_fixture`（实际 package target 依 manifest 确认）、`pnpm check:zcode-cli-rust`、`pnpm test:zcode-cli-rust`、`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。

本批只代表所列临时文件场景，不是 M5 完成：Grep 仍需覆盖 multiline `numMatches`/跨行 entry、NUL 二进制显式路径、UTF-16 BOM 文本一致性、多文件 content/count 顺序与大输出；Glob 仍需完整输入/输出矩阵；权限模式（plan/build/auto-approve/deny/always-ask）、PreToolUse/PermissionRequest/PostToolUse/失败 hooks、Bash 沙箱及取消/并发/大文件仍待验收。不得据此宣称 M5 或产品 parity 完成。
