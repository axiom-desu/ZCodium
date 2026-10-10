# Rust 平台 API 安全替换（本批）

## 目标与边界

在保留 workspace `unsafe_code = deny`、源文件 400 行上限和现有跨平台实现的前提下，消除本批平台代码（含测试）中的全部 `unsafe`。仅修改平台调用相关 Rust 文件及对应 Cargo manifests/lock、对应测试与本 spec；不改主 `cli-rust-runtime` spec、协议/schema、其他 executor 的 path/generator 文件。不得以局部 lint allow、非安全二次 FFI 或删除测试绕过。

## 等价替换与唯一所有者

- Lint compatibility 清理：legacy session 模式恢复将 `Some(value).filter(|_| valid)` 改为 `valid.then_some(value)`；这是 `clippy::some_filter` 的机械等价修复，不改变模式选择或持久化行为。若 clippy 暴露同批机械等价警告，允许仅移除已确认冗余的同类型 PID cast，不改变进程检查语义。
- Windows kernel release 使用 `windows-version` 的安全封装 `OsVersion::current()` 从 `RtlGetVersion` 获取真实 `major.minor.build`；不得把 sysinfo 的 build 与伪造的 `10.0` 前缀拼接。Windows 进程存活判断继续保持保守逻辑。Windows 目标代码尚未通过原生执行验证；尝试目标编译时，若受离线或缺少依赖限制，必须如实报告，不得称为 Windows 检查通过。

- Unix 系统调用统一由 `nix` 的安全 API 承担：信号及进程组属于 `nix::sys::signal`/`Pid`，uname 与可执行权限查询属于 `nix::sys::utsname`/`nix::unistd`。涉及的 crate 各自声明直接依赖；workspace 明确启用 `signal`、`process`、`fs`（按 API 所需），不改变 domain 的纯计算、无 IO 约束。
- Host process clock 保持唯一时钟事实所有者：`sysinfo::System::uptime` 提供系统 uptime，Node 的 `Date.now() - os.uptime()` boot-time wallclock 语义原样保留，不换成 monotonic 时钟；进程 starttime 仍仅 Linux/macOS 有证据时返回，未知仍未知。Linux HZ 本批不改。
- OS 差异只在原有平台 adapter 内处理；进程树继续由既有快照、身份校验、TERM→KILL 与子进程 kill-on-drop 路径拥有。不得改变旧锁记录格式、PID reuse 策略。

## 跨平台语义及失败边界

- POSIX `kill(pid, 0)` 成功或 EPERM 表示活着；其余错误不表示存活。实际发信号仅在权限允许时成功，ESRCH 仍按既有语义视为已退出。进程组所有权和快照身份校验维持原行为。
- Windows 进程查询须保留三态语义：确认存活、确认退出、因权限/查询失败而 unknown。权限拒绝必须不回收；unknown 不得伪装成已退出或无依据的永活。Windows 内核版本继续输出真实 `major.minor.build`，不得替换成 marketing OS version。
- 耗时进程表刷新/平台探测在异步上下文中使用 `spawn_blocking`，不改现有 async API 的外部契约；超时、取消及查询失败按现有失败路径报告，不以无界阻塞或假值兜底。
- Device telemetry lock 的原有 stale-age/owner 判断保持；atomic transaction record 的 owner id/PID 规则保持；Git 探测取消、超时及清理保持。

## 验收场景

1. Unix alive 探测将 EPERM 映射为活着，其他错误不映射为活着；TERM/KILL 与 killpg 目标及 PID 类型转换不溢出。
2. process tree 的 identity/group 保护、退出竞争处理、TERM 后 KILL 和已有测试均保留。
3. Unix release 与 executable-bit 检查保持失败时 unknown/false；Windows kernel release 保持 `major.minor.build` 真实数字格式。
4. uptime 失败不制造 monotonic 替代；wallclock boot-time 算法和未知进程 starttime 不变。
5. 现有 atomic/device/Git/process tree 相关测试继续运行；workspace 全 targets Linux 在线 cargo check、可行时 workspace tests、TS typecheck/lint/architecture、Rustfmt/边界和本 spec 对应 oxfmt 验证。

## 已知风险（不在本批扩展）

进程快照与信号之间仍存在竞态，现有身份快照和组所有权检查是已实现的风险边界而非原子防护；旧锁记录及 PID reuse 策略不在本批重新设计。不能将替换系统调用的工作误认为消除了这些既有风险。
