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
| `node --test --test-isolation=none scripts/ci/*.test.mjs`                                                                     | 341 项通过                                                  |
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

## 初检许可阻塞（历史，补齐结果见下）

在隔离的原 HEAD `7e21a755` worktree、复用同一安装依赖图，复现了相同 npm 失败，确认不是新 CLI 源码造成：

- `node scripts/licenses.mjs notices`：9 个现有包缺完整上游 notices（`@trycua/cua-driver@0.28.2` 及 UBJS 0.31.0-3 包族），因此未重写 aggregate notices/inventory。
- `node scripts/licenses.mjs check` / `check --strict`：14 个现有 CUA/UBJS 实装包的 MIT AND MPL / MPL 分类阻断。未增加 allowlist 或放宽严格门禁。
- 新增 Rust TUI **保守依赖闭包**材料：279 个 registry crate，491 份原始许可快照，登记精确版本、archive URL、Cargo.lock checksum 与字节哈希；不是完整 Rust CLI SBOM。10 个 crate 的归档缺原始 LICENSE/COPYING/NOTICE 文本，明确保留 reviewRequired。
- 新校验从锁文件推导闭包、核对每个来源/checksum，拒绝遗漏、重复、多余项、文件篡改和路径逃逸；CRLF 锁文件文本归一化，原始快照通过 .gitattributes 保留字节。严格检查独立拒绝 Rust 待复核项，不依赖旧 aggregate inventory 是否已登记。
- Rust 材料独立随 Preview 打包到 `resources/licenses/rust-tui`，不会因为旧 npm notices 无法再生成而静默遗漏；这不消除材料缺口，也不构成法律合规认证。

初检时这些问题阻止 release-ready；后续材料补齐结果如下。无需用户提供 Windows/macOS 设备来执行当前 CI 已配置的非交互检查。

## 上游许可原文补齐

- CUA/UBJS：保存 15 个精确包版本的必要公开 registry 字段快照和原始响应摘要（不收录 publisher 联系信息或内部运维字段）、与同名同版本 pnpm 锁条目相等的 integrity、6 份固定源码材料（MIT/MPL 原文、原始 runtime NOTICE、构建源码和版本证明）。记录 core 与 node/platform 不同的 publisher gitHead，并提供对应源码获取方式和本地打包变换说明。9 项缺原文和 14 项许可分类阻塞已消除；只对证据完整的精确包名/版本/表达式复核，不是通用 MPL 豁免。
- Rust：JNI 系列、RMCP、Android verifier 已按 archive VCS 取得同期原文；r-efi 的完整 MIT 与原始版权实际在 archive/AUTHORS，收集器已修复；两个 winapi GNU 包缺 archive VCS，但全部 1390 / 1419 个原始发布文件（含 Cargo.toml.orig 和静态库）逐一匹配到 Git revision `b76bbbf40dbfe5bec35a566caa70fd852824213a`，保留文件级证明及同 revision 的 MIT/Apache 原文。
- objc2 两个 crate：补齐原始许可声明以及明确选择的 Apache-2.0 标准条款，标准文本没有冒充项目原始版权。原声明还明确提示 Apple SDK 衍生源码许可不确定性，故两项实质复核仍保留，不靠补全文本假装授权疑问消失。
- 当前 Rust 材料：279 个 crate、492 份 archive 原文、17 份额外上游/明确标记的标准条款，以及 source-match 证明。原先 10 项都已有文本材料。
- 修复生成器将“本机没有安装但仍锁定的其他 libc/platform override”误判为陈旧的问题；锁文件中不存在的版本依旧拒绝。
- `node scripts/licenses.mjs notices` 成功重生成 aggregate（1123 个生产包版本）；`node scripts/licenses.mjs check` 通过（1715 个实装包）。`check --strict` 仍阻断 **16 项**：14 项更早的 publisher/copy/Skia/QuickJS/Rust std 原文或构建来源记录，加上述 2 项 objc2 实质问题。未删除这些记录，未宣称 release-ready。

许可原文、版本绑定、变更/缺失/篡改/错包 integrity/source-match 负例已补测试；普通检查不依赖网络或开发机 Cargo cache。同步与校验说明见 `third-party/README.md`。

## PR CI 后续结果

初版 `3f2e9100` 的 CLI Rust CI 已通过，包括 Windows/macOS 的 compile 与非 TTY 入口测试；Desktop 的四个 Windows/Linux 构建也通过。Desktop Checks 在真实 Electron probe 被 runner 的 SUID/userns 策略提前终止处失败，而不是 CLI 断言本身。现仅对隔离测试 child 显式设置 `ELECTRON_DISABLE_SANDBOX=1`，不改变产品沙箱；本地回归通过，新提交后由 CI 重新确认。
