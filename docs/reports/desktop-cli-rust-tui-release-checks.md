# Desktop CLI / Rust TUI：发布检查记录

## 结论

功能与 Linux 隔离验收通过；**尚不可标为 release-ready**，以 Draft PR 交付。未发布、未覆盖安装、未改真实用户会话或凭据。测试采用本地模型 fixture；不代表真实外部 provider 或完整 TS TUI 功能对齐。

## 本轮变更

- Desktop 首位置 `--cli` 在 GUI imports 前分流。Production 默认 TS、Preview 默认 Rust、开发默认 TS；显式 runtime selector 非法或物料缺失即失败，不跨语言回退。
- TS 复用 Electron Node 和真正 TUI 依赖闭包；显式复制 Builder 默认忽略的资源根 node_modules，并在 afterPack 校验文件完整性。随入口携带 provider 配置与 notices。
- Rust 采用 ratatui/crossterm，消费原 Engine canonical topic；支持多轮、流式文本、工具结果、权限/询问、取消、会话恢复与模型/模式命令。显示窗口有界，不截断 actor 历史；root 唯一负责 Eof/drain/actor 生命周期。
- Windows/macOS 原有 Rust 全目标 compile CI 保留，增加真实非 TTY `cli_entry` 测试。未冒充这些平台的交互终端实机验收。

## 已执行

Node 使用 `mise.toml` 指定的 **24.14.0**（隔离工具目录，不修改项目版本）；Rust 使用当前可用工具链与锁文件。

| 检查                                                                                                                          | 结果                                                        |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `pnpm typecheck`                                                                                                              | 通过                                                        |
| `pnpm lint`                                                                                                                   | 0 errors，50 warnings                                       |
| `pnpm architecture:check --changed`                                                                                           | 0 violations / 0 baseline / 0 new                           |
| `pnpm fmt:check -- '!logs/**'`                                                                                                | 通过；不改用户既有未追踪 logs                               |
| `pnpm check:zcode-cli-rust`                                                                                                   | crate boundaries / fmt / workspace all-target clippy 通过   |
| `pnpm test:zcode-cli-rust`                                                                                                    | 495 项通过                                                  |
| `node --test --test-isolation=none scripts/ci/*.test.mjs`                                                                     | 332 项通过                                                  |
| `pnpm -r --filter './apps/zcode-cli/packages/*' build` / `test`                                                               | 通过，当前有测试脚本的包共 141 项                           |
| `pnpm test:zcode-cli-rust-drivers`                                                                                            | 52 项通过                                                   |
| `pnpm check:zcode-cli-rust-protocol-schema` / `check:zcode-cli-rust-contract-assets` / `check:zcode-cli-rust-domain-fixtures` | 通过                                                        |
| Desktop CI 的远控/协议/adapter/mobile 定向 Vitest                                                                             | 175 项通过                                                  |
| `pnpm vitest run --config packages/ui/vitest.holes.config.ts`                                                                 | 19 项通过                                                   |
| `pnpm test:zcode-cli-rust-interop`                                                                                            | alternate / crash / concurrent 通过，7 个会话读取比较无差异 |
| `node scripts/ci/desktop-release.mjs check-version`                                                                           | 通过                                                        |

根 `pnpm fmt:check` 不加过滤时会报告用户既有未追踪 `logs/` 中 5 个 JSON 的格式；未修改、未提交这些文件。CI clean checkout 不包含该目录。

## 真实打包验收

实际构建了 Linux Production 与 Preview 的 unpacked app（非模拟入口）：

- Production `zcodium-exp --cli` 在不设置 runtime selector 时，TS help / headless / PTY 模型应答通过；双 Ctrl-C 保留原退出码 130，termios 恢复。
- Preview `zcodium-rust --cli --help` 无 DISPLAY 成功；`node scripts/zcode-cli-rust-tui-smoke.mjs --binary=<packaged-executable> --desktop` 通过多轮、真实 Read marker、Write 拒绝/允许、AskUserQuestion、慢流 Ctrl-C 后继续、同 session continue 与模型上下文、退出、SIGTERM 143 和 termios 恢复。
- Preview 显式 TS override 的真实 PTY 与无头请求通过，未依赖系统 Node 或仓库 node_modules。
- Preview 不带 `--cli`、不设置 selector 时，真实 GUI packaged=true、数据库 ready、模型会话与 Read 实际文件通过。
- Preview 的 `resources/licenses/rust-tui/sources.json` 实际随包存在；原有 native/resource/remote asset 校验保留。

测试包、隔离 profile、截图、stdout/PTY 证据仅在临时目录，不进入 Git。未对 Windows/macOS 声称上述运行验收；由 PR 的 native runner 提供后续 compile/入口测试结果。

## 测试基线修复

`c31f7e97` 已删除购买 webview 及 `packages/ui/test/localOnlyWebview.test.ts`，但 `scripts/ci/local-observability.test.mjs` 仍导入该文件。仅清理遗留引用，未恢复已删除功能，未 skip 当前测试。诊断入口恢复运行，28 项全部通过。

## 发布许可阻塞（未豁免）

在隔离的原 HEAD `7e21a755` worktree、复用同一安装依赖图，复现了相同 npm 失败，确认不是新 CLI 源码造成：

- `node scripts/licenses.mjs notices`：9 个现有包缺完整上游 notices（`@trycua/cua-driver@0.28.2` 及 UBJS 0.31.0-3 包族），因此未重写 aggregate notices/inventory。
- `node scripts/licenses.mjs check` / `check --strict`：14 个现有 CUA/UBJS 实装包的 MIT AND MPL / MPL 分类阻断。未增加 allowlist 或放宽严格门禁。
- 新增 Rust TUI **保守依赖闭包**材料：279 个 registry crate，491 份原始许可快照，登记精确版本、archive URL、Cargo.lock checksum 与字节哈希；不是完整 Rust CLI SBOM。10 个 crate 的归档缺原始 LICENSE/COPYING/NOTICE 文本，明确保留 reviewRequired。
- 新校验从锁文件推导闭包、核对每个来源/checksum，拒绝遗漏、重复、多余项、文件篡改和路径逃逸；CRLF 锁文件文本归一化，原始快照通过 .gitattributes 保留字节。严格检查独立拒绝 Rust 待复核项，不依赖旧 aggregate inventory 是否已登记。
- Rust 材料独立随 Preview 打包到 `resources/licenses/rust-tui`，不会因为旧 npm notices 无法再生成而静默遗漏；这不消除材料缺口，也不构成法律合规认证。

解除上述材料与许可分类阻塞、成功重生成 aggregate inventory 并完成 strict 复核后，才可将 PR 标为可发布。无需用户提供 Windows/macOS 设备来执行当前 CI 已配置的非交互检查。
