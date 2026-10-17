# Desktop CLI / Rust TUI 发布检查与测试基线

## 本轮边界

用户要求完成发布检查、处理测试 baseline 并开 PR；无 Windows/macOS 实机。只提交源码、规格、可复现验收和必要许可材料，不提交二进制、用户数据或 logs，不覆盖当前安装。

- 测试入口必须引用当前存在的测试。已被产品移除的购买 webview 不应恢复，仅清理随功能删除遗漏的旧测试引用；保留其余本地诊断测试且实际运行全量脚本测试，不以 skip 或扩大 timeout 假装通过。
- 新增 Rust TUI 依赖许可范围明确选择为 Rust CLI Cargo.lock 中由 `zcode-cli-rust-tui` 直接依赖展开的完整 registry closure（含目标平台条件依赖），而不是 native-search 的旧上游锁，也不声称覆盖 Rust CLI 全部锁定依赖。每个 closure crate 必须登记精确 name/version/crates.io source/lock checksum、归档 SHA-256、原始 crate 内 LICENSE/COPYING/NOTICE 快照及其 byte hash；许可文件缺失或识别不出许可时显式 `reviewRequired`，不得生成假材料。登记和快照纳入现有 notices/inventory 的生成与普通新鲜度检查，检查不得依赖本机 Cargo cache。通过公共 crates.io 下载获得缺失归档时，须校验 Cargo.lock checksum 后才读取快照。
- Rust TUI closure 不覆盖全部 Rust CLI Cargo.lock registry 依赖，属于明示范围限制；发布输出同时列出范围。strict 门禁仍严格阻断全局既存 reviewRequired，不自动豁免/冒充合规认证；新增材料不足也必须显式阻断 strict。
- 许可材料唯一登记 owner 为 `third-party/rust-tui/sources.json` 与其中引用的仓库内快照；生成器以 Cargo.lock 为锁定事实，验证 closure、版本/checksum、源快照及输入哈希，notices 仅由生成器渲染。Cargo.lock 漂移、快照篡改、closure 缺登记都应由许可专项 fixture 测试检出。CI 在现有 Windows/macOS runner 上至少编译 Rust 全目标并执行可用非交互 CLI 入口测试；真实终端人工验证和 Linux PTY 验证分开报告。保留现有桌面发布门禁。
- 最终执行根 typecheck、lint、fmt、架构与 Rust fmt/clippy/workspace tests、脚本测试；按当前 package.json 执行可用协议/差分验证，Linux 打包 CLI/GUI 的真实验收结果需明确对应测试构建。
- Preview 的 Rust 许可快照独立随包放入 resources/licenses/rust-tui，避免既有 npm notices 无法再生成时遗漏新增材料；未知材料仍保留 reviewRequired。锁文件文本哈希归一化 CRLF，许可原文快照保持字节不变；strict 检查也要直接拒绝新 Rust 待复核项，不能只依赖旧 aggregate inventory。
- Rust TUI notice 验证固定读取 `apps/zcode-cli-rust/Cargo.lock`，从 TUI package 派生 registry 闭包并与 inventory 的 name/version/source/checksum/archiveSha 逐项精确相等（拒绝重复、遗漏及多余项）；sync 与 verify 共用同一 lock graph parser。快照仅允许位于 `third-party/rust-tui/snapshots/`，拒绝路径穿越、绝对路径及 symlink 解析后越出该目录；无 notice 的 crate 必须带 `reviewRequired` 且 strict 阻断。
- 仅推送当前 feature 分支并开 main PR，不自动合并或发布；PR 中记录测试命令、结果、既有失败和跨平台限制。存在未消除的发布许可阻塞时开 Draft PR，不宣称 release-ready。
