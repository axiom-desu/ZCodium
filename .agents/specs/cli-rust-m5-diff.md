# M5 Rust diff：structuredPatch 与 jsdiff 对齐

## 范围与所有者

本切片把 Rust `apps/zcode-cli-rust/crates/tools` 的结构化 diff 对齐本仓库 TS CLI `apps/zcode-cli/packages/core/src/tool/diff.ts::createStructuredPatch`（`diff` npm 包 v9.0.0，`context: 3`、`timeout: 5_000` 的 Myers diff + hunk 合并）。

- 唯一生产路径是 `crates/tools/src/file_diff.rs`：`patch_async`（async 边界）调用 `patch_inner`（同步编排）。Myers 遍历、`Node`/`extractCommon`/`buildValues` 与 deadline 在 `file_diff/myers.rs`，hunk 合并与换行处理在 `file_diff/hunks.rs`，测试仍是 `file_diff_tests.rs`，避免单文件超过 400 行上限。其调用方只有 `file_result`（Write/Edit 的 adapter `structuredPatch`、display、`hunkCount`/perf）和 `file_changes`（checkpoint 汇总 patches）。`file_write` 只保留原子写入，不生成补丁。
- 不新增 diff 业务状态、缓存或第二份 hunk 结果；不新增依赖，复用现有 `serde_json`、`tokio`、`anyhow`。
- oracle 是实时 TS `ToolEntry` handler + 默认 `NodeFileSystemAdapter`；不在测试里复制算法或硬编码期望 hunk。Rust 侧只操作独立临时 workspace。

## 接口与顺序

```text
file_result::result / file_changes::details   (async, tokio worker)
        └── file_diff::patch_async(old: String, new: String) -> Result<(old, new, hunks, additions, deletions)>
                │   spawn_blocking：O(N·D) 的 Myers 不在 tokio worker 上跑
                └── patch_inner(old, new, expired)
                        ├── tokenize（`myers.rs`）：`/\n|\r\n/`，借用原文本 `&str`（不逐行复制）
                        ├── 公共前缀裁剪：jsdiff editLength 0 先消费前缀，等价；不裁剪公共后缀
                        ├── Myers diff：Rc 共享链（`base.js`/`buildValues`，默认行选项）
                        ├── deadline：`expired()` 在每个 editLength、每个 diagonal 以及 extractCommon 的长公共段检查
                        └── hunk 构建（`hunks.rs`）：context=3，合并 <= 2*context 的相邻区间
                              → 去行尾 \n，必要时插入「\ No newline at end of file」
```

- `patch_async` 返回原 `old`/`new`，Write/Edit 结果不需要为 diff 额外克隆输入。
- `patch_inner` 的 `expired` 是可注入谓词：生产是 `Instant::now() >= 开始 + 5s`，测试可注入步数/标志以确定性触发超时。
- `additions/deletions` 等价 TS `countPatchLines`（统计 `+`/`-` 行）。

## 超时语义（照 TS）

TS `structuredPatch` 在 `diffWithOptionsObj` 的 editLength 循环里检查 `Date.now() <= abortAfterTimestamp`；超时返回 `undefined`，`structuredPatch` 把它折叠为 `undefined`，`createStructuredPatch` 的 `patch?.hunks ?? []` 得到 `[]`，`countPatchLines([])` 得到 `{additions: 0, deletions: 0}`。`file_changes` 对应的 TS `runtime/helpers/turn-file-changes.ts::diffLineStat` 也传 `timeout: 5_000` 并做同样的 `?.hunks ?? []` 折叠，因此两个 Rust 调用方共享同一超时语义。

Rust 对齐该结果：

- 生产预算固定 5s（`diff.ts::DIFF_TIMEOUT_MS`），在 Myers 遍历中反复检查；为收紧最坏情况，除 editLength 循环外 diagonal 循环也检查。
- 超时返回空 hunks、`additions = 0`、`deletions = 0`，不返回错误。
- 超时是墙钟判断，只保证结果形状一致，不保证与 Node 在同一输入上于同一 editLength 中止（两者都返回空）。
- 生产 `expired()` 在每个 editLength、每个 diagonal 以及 `extractCommon` 的每 4096 行公共段采样；采样间隔内不做时钟读取，保持比较热路径不变。

## 内存与 dead-line 边界

- 输入上限是 Write/Edit 的 8 MiB（`EDIT_BYTES`）。Myers 最坏 O(N·D)，此前的 index arena 会保留所有历史节点直到整个 diff 返回，内存随编辑数增长。
- 裁剪公共前缀覆盖“大文件小改动”的常见路径，使 Myers 只处理前缀之后的窗口；公共后缀由获胜路径的 `extractCommon` 一次性消费，不靠预裁剪压缩 frontier。
- 路径链改用 `Rc`：frontier slot 被 prune/覆盖时不可达节点立即释放，内存随存活 frontier 而非历史节点增长（与 jsdiff 的对象图一致）。`Node` 手写 `Drop`，沿 `previous` 迭代解开链（`Rc::try_unwrap` 只处理独占节点），避免深链在最后一个 `Rc` 释放时因默认递归析构导致栈溢出。
- `tokenize` 返回 `&str` 切片，不复制每一行。
- deadline 只对可能超预算的 Myers 相关循环采样检查：`extractCommon` 的公共段可能横跨裁剪后的整个中段，按固定间隔复检；`tokenize` 与公共前缀扫描是输入规模的单次线性遍历（Write/Edit 输入上限 8 MiB），且 jsdiff 的 5s 预算在 tokenize 之后才开始，故不在此加检查。
- 未新增任意数值的 arena/节点硬上限：5s 墙钟限制最坏情况的分配量，硬编码上限需要单独设计论证（例如按输入规模推导或分层降级），本切片不擅自添加。residual worst case（大量互异行的对抗输入）仍可能在 5s 内分配较多内存，这一点在“限制”中保留。
- 5s 预算内的检查点使对抗输入能在有限时间内返回空结果，而不是无限 CPU。

## 本批验收场景

- 单个变更：前后各 3 行上下文。
- 两处远离变更：各自成 hunk。
- 间隔 <= 6 行：合并为一个 hunk（相邻 hunk 合并边界）。
- 间隔 7 行：保持两个 hunk（边界）。
- 重复行 `a/b` 交替：Myers 对齐结果一致。
- 重复行 tie-break：`a\nb\na\n` → `b\na\na\n` 删除首个 `a` 并在尾部追加新 `a`（pre-trim 公共后缀会改结果，已移除）。
- 固定 seed 的重复行随机差分：单批 300 例 old→new 一次 oracle/fixture 进程对比（`scripts/tests/cli-rust-m5-diff.test.mjs`）。
- 深路径链（50 万节点）析构不依赖递归 drop，不触发栈溢出。
- 纯插入、纯删除：`oldLines`/`newLines` 正确。
- 尾部换行：文件末尾无换行时插入 `\ No newline at end of file`；新增/替换末行覆盖。
- 空到文本、文本到空：`oldLines`/`newLines` 可为 0。
- 40 行多点变更：多 hunk。
- 10k 行只在中间改一行：前缀裁剪后仍产出与完整 Myers 相同的 3 行上下文 hunk，公共后缀由获胜路径的 `extractCommon` 消费。
- 可注入短 deadline（不依赖 5s sleep）：Myers 遍历中多次检查后中止，返回空 hunks / 0 / 0。
- 大输入（40k 互异行）在 current-thread tokio runtime 上：diff 跑在 blocking 池，另一个 async task 能推进；随后中止返回空 hunks / 0 / 0，并有 2s fallback 防回归卡死。
- Edit 替换整文件、以及 Edit 在空文件上创建：同样走 `file_diff`。
- driver 子进程有 180s timeout；超时 kill 进程组并 await close，避免 CI 永挂。

## 已确认差异与修复规则

- 修复前 `file_write::patch` 只用公共前缀/后缀合并出单个 hunk。实时 oracle 确认：同一 old→new 下 TS/jsdiff 对相隔较远的变更输出多个 hunk（例如 20 行文件改第 3、17 行得到两个 hunk），Rust 输出一个横跨全文件的合并 hunk；仅当变更相邻时两者才一致。修复方式是移植 jsdiff 的 Myers diff 与 hunk 合并规则，而不是继续扩展单区间合并或按场景硬编码。
- 迁入 Myers 后曾为压缩 frontier 预裁剪公共后缀。实时 oracle 发现这不等价：jsdiff 只在 editLength 0 消费公共前缀，公共后缀是否进入获胜路径取决于等长编辑脚本的 diagonal 顺序；重复行时预裁剪会改变 tie-break（`a\nb\na\n` → `b\na\na\n`，jsdiff 为 `-a / b / a / +a`，预裁剪为 `-a / b / +a / a`）。修复是移除后缀预裁剪，保留前缀裁剪（jsdiff 先消费前缀，无歧义），公共后缀交给获胜路径的 `extractCommon`。`file_diff_tests.rs::duplicate_lines_do_not_assume_a_common_suffix` 与 300 例固定 seed 随机差分共同守卫该边界。
- 本轮回归是移植 Myers 后缺少 TS 已有的 5s 预算且直接在 tokio worker 上同步执行。修复是恢复 5s deadline（遍历中检查、超时空结果）并把执行放到 blocking 池，而不是用 `tokio::time::timeout` 包住同步调用（超时无法中断同步计算）。

## 已确认分歧（本切片只记录，不扩边界修复）

- CRLF / `data.content`：TS `contentToWrite` 与 `originalFile` 保留模型的 `\r\n`，`createStructuredPatch` 直接 diff 含 `\r` 的文本；Rust Write/Edit 适配器先规范化为 LF（`data.content` 和 diff 输入都是 LF），CRLF 只在文件写回层恢复。该分歧属于 Write/Edit 内容与 `NodeFileSystemAdapter` 的既有语义，修它会改数据面而不只是 diff；本切片只保证算法对含 `\r` 行的行为由 `file_diff_tests.rs::crlf_context_lines_keep_carriage_returns` 覆盖。
- `display.filePath`：TS `result-display` 用调用方 `filePath`（模型给出的 `file_path`）；Rust `display.filePath` 用 `Written.path`（canonicalize 后的绝对路径），而 `data.filePath` 仍用模型路径。
- 空 hunk 的 display：TS 在 `hunks.length === 0` 时 `result-display` 返回 `undefined`（无 `file_diff`）；Rust 仍会输出 `file_diff` 且 `additions/deletions = 0`。该差异同时存在于 Write `type: "create"`（TS 无 patch/display，Rust 计数后置空 display patch）和超时路径，属于既有 Write 结果语义，本切片不改变。

## 未覆盖边界

- 超时只声明结果形状，不声明与 Node 的墙钟中止点或最大 editLength 一致。
- 未覆盖大 patch 截断阈值差异（TS `boundDiffHunks` 与 Rust 32KB 截断）与 multiline/二进制等其它工具边界。
- 对抗性输入在 5s 内的峰值内存没有硬上限，见“内存与 deadline 边界”。
- checkpoint `file_changes` 仍会剥离 BOM 后再 diff，与 TS raw-content summary 尚未对齐；本批 Write/Edit oracle 不覆盖 checkpoint 汇总。
- blocking worker 若 panic，当前仍返回工具错误，但原子写已提交；这不是 timeout（timeout 返回空 patch）。当前测试未验证该低概率失败路径的产品语义，不能据此宣称提交后错误完全对齐。

## 验收与边界

命令：

- `node --import tsx --test scripts/tests/cli-rust-m5-diff.test.mjs`（本切片差分 driver，实时 TS oracle + `examples/tool_fixture`）。
- `cargo test --offline --locked --manifest-path apps/zcode-cli-rust/Cargo.toml -p zcode-cli-tools --lib`。
- `cargo clippy --offline --locked --manifest-path apps/zcode-cli-rust/Cargo.toml -p zcode-cli-tools --all-targets`。
- `pnpm architecture:check --changed`。

本切片只代表所列形状的 `structuredPatch` 对齐，不代表 M5 完成，也不覆盖权限/hook、Bash、Grep/Glob 剩余矩阵。
