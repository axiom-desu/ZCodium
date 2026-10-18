# Rust standalone CLI 的 Provider 配置发现

## 问题与规则（实现前）

已安装的 ZCodium Rust `--cli` 裸启动报告 `Selected model is unavailable`。Desktop GUI Host 会注入两条 provider 路径；公共 CLI bootstrap 不初始化 GUI/Host，而 Rust root 只调用 `Registry::from_env`，两条路径均缺省时没有 registry。之前 GUI deb smoke 和 TUI fixture 显式传入了两条路径，未覆盖此入口。

- 修复 owner 为 Rust root composition：TUI 与 headless prompt 的独立运行模式解析 provider 文件；app-server 保留 Host 管理的 `Registry::from_env` 语义。通用 model Registry 不猜 Desktop 路径、不写环境变量、不导入 Runtime 实现。
- 显式 `--config` 仍优先走既有单模型文件，不额外解析 provider 文件。
- builtin/personal 环境路径分别优先；空白视为未设置，单独指定其中一个时另一项独立发现。显式无效文件不得被其他候选掩盖。保留原默认模型选择/推理档位解析，不随意切换用户模型。
- personal 默认 `(ZCODE_DATA_BASE_DIR || HOME)/.zcodium-exp/v2/provider_config.json`，复用生成的 canonical 目录常量。
- builtin 默认先找同一 app config 目录内已物化的 `runtime/provider/bundled/zcode-builtin.json`，无此文件才找当前 executable 的相邻 packaged `../config/provider/zcode-builtin.json` / `../glm/provider/zcode-builtin.json`。
- 源码 Cargo 可从编译期 checkout 锚点发现 `config/provider/zcode-builtin.json`，但仅当 executable 确认位于该 checkout 的 target 目录。安装包缺资源不能误读开发 checkout 或当前 workspace 下的文件。
- 不改 GUI/app-server、TS CLI 的现有配置路径、不新增 profile 迁移/写入或第二份配置，不改变 storage owner/lease、workspace identity、admission、desktop-continuous/web-replayable 语义。
- 独立 CLI 确实没有可用模型时，在创建会话/请求模型前明确提示用 ZCodium 设置页配置个人模型或提供 `--config`，不再用无上下文的不可用错误冒充启动配置已完成。错误/测试证据不得输出密钥、配置正文或真实服务地址。

```text
zcodium-rust --cli / 原生独立 binary
  → root standalone provider resolver（只读明确路径）
  → 既有 Registry / default_selection → 唯一 Engine/存储 owner → 原 TUI/headless

GUI Host → 显式 provider 路径 → app-server 原 from_env（不变）
```

## 验收

1. 路径优先级：双/单显式、空白、canonical materialized、两种 packaged 布局、Cargo checkout 锚点、与 cwd 无关；已声明文件坏掉/缺失不悄悄改读另一份。
2. 原 app-server 缺省/单路径/双路径语义和静态 `--config` 不变；help/version/non-TTY 仍在 runtime/库访问前返回。
3. 用隔离 HOME/data 根写 canonical provider 配置，清空两条 provider 环境路径及 runtime override，真实 PTY 从新 deb 的 `zcodium-rust --cli` 进入 TUI，多轮/Read/权限/取消/恢复与历史上下文均通过；禁止用 `-p`/`--config` 或强制 env 让裸启动假通过。先用旧 deb 复现错误。
4. 重新本地构建 Rust deb，确认调用的是新包内资源；已有 GUI 基本 smoke 不回归。不得修改真实用户配置/库、不得公开安装包、push/tag/release。
5. 跑 Rust tests/fmt/clippy/boundaries、定向脚本测试、根 typecheck/lint/架构。保留现有双包 CI 工作区改动和 `logs/`，记录实际结果与未执行边界。

## 本轮证据（仅本地）

- 旧已安装 `/opt/ZCodium Rust/zcodium-rust --cli` 在临时 HOME、canonical provider 文件、没有两条 provider 路径环境变量时，真实 PTY 稳定复现 `Selected model is unavailable`，未读真实用户配置。
- 新 root 模块 `provider_config.rs` 只负责独立入口的只读发现；`standalone_engine` 和 Host 的 `engine` 共用同一个 Engine 构造，app-server 仍走原 from_env 分支。
- 新 debug binary 的默认配置发现 PTY 通过。随后从当前工作区重打两个本地 Linux x64 deb，在新 Rust deb 的公共 `--cli` 入口分别验证 canonical materialized builtin、仅 personal 配置加随包 builtin 两种场景，均通过；每次 14 次本地模型请求，无 provider 路径或 runtime override。
- 真实 PTY 覆盖多轮、Read、Write allow/deny、AskUserQuestion、取消、session list、continue 历史和信号/终端模式恢复。新版两个 deb 的 GUI 对话/Read/重启恢复/追问也通过。
- 最终验证：Rust workspace 501 项测试、fmt、Clippy（deny warnings）及 16-crate 边界通过；Node CI 脚本 358 项通过，根 typecheck、CLI i18n/TUI typecheck、架构与 actionlint 通过，Lint 0 errors / 50 条既有 warnings。格式检查排除原有 `logs/` 后通过。
- 安装包只在 `/tmp/zcodium-cli-fix/production/`、`/tmp/zcodium-cli-fix/preview/`；证据仅落本机 `/tmp/zcodium-cli-fix/`。未改动系统安装、用户配置、真实会话或日志，未 push/tag/release。
- 这是未提交工作区的本地重打包，滚动版本仍为 `3.15.1-20261018.374`；当前系统里的旧包不会自动更新，需维护者显式重新安装修复包，不能只比较版本串判定二进制是否已更新。
