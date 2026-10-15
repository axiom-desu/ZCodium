# Rust CLI：分层 PR 审阅约定

## 目标与不变量

将完整 feature 分支按依赖闭包拆成 stacked PR，而不是把约 42.8 万行直接交给一个 reviewer。原 feature 分支不 rebase、不 force-push；现有 `recon/*` 分支不修改。保留既有 PR #51–#53（recon/01–03）；从 recon/03 接新层替代巨型 #54，旧 #54 只标注 superseded 并关闭，不删除原分支。新分支使用 `stack/cli-rust/*`。

- stack 顶层文件树必须与冻结后的 `feat/cli-rust-runtime` **完全一致**（包括 SQL/fixture 字节），不借拆 PR 改产品行为。
- 依赖顺序单向，每个 PR base 指向前一层；合并时从底向上。GitHub 不自动维护整个 stack，父 PR 合并后需要复核下一层 base/diff；新增层初始均 draft，不开启自动合并；旧 #51–#53 的状态保留。
- 中间层使用 M0 已有的占位 binary/library 形式，尚未填充的 crate 只有文档注释；不是可用 runtime，不可发布。先注册最终 Cargo manifests/lock/边界，逐层替换成最终源码。不得伪造业务实现或移走 schema 来规避检查。
- 大 JSON/schema/fixture 和 22 个历史 migration SQL 单独落一层；源码消费方不早于该层，数据 blob 与冻结 feature 完全相同。其来源分为当前 TS generator 和上游静态快照，不能把未移植生成器的快照写成可重复生成。
- 中间 CI 仅启用已落地的功能 gate；完整 Node driver、contract 与 interop job 在 CLI wiring 层启用。不移除 `--locked` 或放宽 crate 边界。
- 每层以真实 `cargo check --workspace --locked` / boundary 验证建立可编译证据；不将静态检查等同所有单测或产品验收。GUI/部署/目标 ISA 执行不属于此次 PR 操作。

## 层次（按合并顺序）

1. 既有 #51 / `recon/01-m0-skeleton`：M0 骨架与基础 CI。
2. 既有 #52 / `recon/02-desktop-preview`：Preview 随包分发接线。
3. 既有 #53 / `recon/03-protocol-m1`：M1 protocol 与 TS 契约漂移。
4. `04-schema-foundation`：schema 抽取、最终 manifests/lock/边界、protocol/command oracle 对齐；其它 crate 保持 M0 占位。
5. `05-data`：Rust JSON/schema/fixture + migration SQL 原样快照，隔离约 30 万行大数据。
6. `06-domain`：纯 domain 源码，数据已在前层；这是天然较大的机械迁移审阅单元。
7. `07-platform-contracts`：core-api / host / net。
8. `08-core`：会话 owner、admission、commit barrier、取消/恢复状态机。
9. `09-state-model`：SQLite adapter/冷读/恢复、三协议 HTTP/SSE/retry/cancel；各 crate 在 PR 内分 commit，单独审阅。
10. `10-bash`：bash-parse / bash；巨型静态表已隔离在数据层。
11. `11-plugins`：插件/MCP 配置与安装 adapter。
12. `12-tools`：工具 adapter、权限/hooks、文件 diff/Grep 修复；跨语言完整验收仍待 wiring 层。
13. `13-cli-wiring`：app-server/headless/tui、root 组合、集成测试/examples、生成器、Node driver、完整 Rust CI。
14. `14-desktop`：Services 显式 resolver + Desktop native storage preparation、打包接线、Electron smoke 驱动/M8 报告；此层尚不默认启用 Rust。smoke 为草稿，不声称完整 App E2E 通过。
15. `15-preview-default`：只在 ZCodium Rust 打包 flavor 默认 Rust，资产矩阵与 CI 回归；性能驱动/报告、RISC-V 编译证据及其余文档；恢复最终 feature 的精确文件树。

## 审阅指南

- 数据层只核对来源、blob identity、SQL 校验和与消费边界，不要求逐行人工阅读 30 万行 JSON。
- 源码层按 crate 阅读，机械上游导入与本地对齐的来源在 NOTICE/spec 说明；源码行多不等于每行均由本轮新写。
- 功能状态和已执行测试以 PR 描述及 handoff 为准；M2–M8 受控切片不是全量 parity。
- RISC-V 仅完成 cross compile/link 与 ELF 检查，未运行/部署；远端部署仍 TS/Linux x64，不因该报告自动改变。
- 不提交 `target/` 二进制、临时日志、用户数据或原有未跟踪 `logs/`。
