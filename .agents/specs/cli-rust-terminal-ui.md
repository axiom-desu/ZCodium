# Rust 原生终端 CLI / TUI

## 用户要求与本轮范围

用户在统一 Desktop `--cli` 分流后明确要求实现真正的 Rust CLI，可参考现有 TS CLI、自由选库。已有 Rust headless `-p` 与 app-server 保留；移除裸启动/`tui` 的未实现占位，提供可用的原生交互终端，不调用 TS/Bun/Node TUI 冒充。

本轮是有明确边界的可用终端前端，不宣称完整 TS TUI 功能或跨平台人工验收全部完成：

- 无参数和 `tui` 进入交互终端；支持 cwd/config/data-dir、continue/resume 和已有合理公共选项，帮助准确描述已实现能力。headless 与 app-server 参数/协议/退出语义保持不变。
- 多轮输入、流式 assistant 文本、工具调用/结果/失败可见、运行状态、取消、权限和询问应答；中文/Unicode 编辑、粘贴、换行、窗口 resize、滚动以及正常/错误退出时恢复终端。
- 复用原有 Rust Engine/Node session store/provider registry/工具和权限策略；默认交互权限模式与 TS TUI 一致，不因 UI 未实现而自动批准或以 yolo 启动。已有 `--mode` 显式选择保留。
- 会话持久化、`--continue` / `--resume` 恢复同一 session；至少提供准确 `/help`、`/quit`、`/new`、`/sessions`、`/resume`、`/mode` / 模型切换（若源 runtime 没有可用模型列举契约则清楚说明支持的输入），未知命令明确提示，不伪造成功。
- 不把 pending UI 输入当成已接受命令；busy 时不维护第二个业务队列，发送被拒绝则保留草稿/显示原因。取消走现有 stop admission，而不是关闭 runtime 假装停止。

## 唯一所有者与事件顺序

```text
terminal keyboard/paste → TUI draft / request token
       → ClientMsg（原 core-api）→ Rust Engine actor / admission
       → session event / snapshot / persisted rows（唯一事实）
       → TUI 展示投影 / assistant stream / tool / permission prompt

permission/question → 用户明确选择 → 原 command/host reply → Engine
Ctrl-C while busy → 原 stop command → terminal event → ready for next input
quit/EOF/signal → root sends Eof; failure/signal also cancel → concurrently drain output and await actor → restore terminal → process exit
Desktop continuous / 手机 replayable 仍由原 delivery 处理；TUI 不改其 seq、owner 或 lease。
```

- Rust root binary 拥有 Context/存储 owner lock/adapter 组合和 runtime 生命周期，与 headless/app-server 共用原构造，TUI crate 仅消费 core-api transport 与终端 IO。root 是唯一 Eof owner：无论 TUI 正常返回、出错或收到外部信号，root 都发送 Eof，并并发排空输出、等待 actor 结束；失败/信号同时取消 runtime，不能依赖 frontend 发送 Eof 或用超时掩盖未结束 actor。
- TUI 拥有的仅是编辑器草稿、显示列表/滚动、请求关联 token、当前选择/待用户回答的投影；session、accepted queue、工具权限决定和持久化由原 runtime 拥有。
- 显示投影必须有行数和文本字节预算，超出只截断终端显示，不截断 actor/持久化历史或交互参数。TopicClosed 使旧 busy/审批投影失效，仍可 `/new` 恢复；运行错误/取消必须可见。`/new` 沿用当前模式选择，恢复会话保留原模式，显式启动 `--mode` 可覆盖恢复模式。
- 使用现有 SessionCreate/Resume/List/Subscribe、v4 command、session/event、HostRequest 等契约。识别 session/turn/request 关联，迟到旧 turn/旧 session 消息不得污染新界面；权限/问题不能按当前“最后一个请求”猜测路由。
- stdout/stderr 终端 IO 与 app-server stdout 严格分开；TUI 不启动 GUI、不含外部模型密钥日志；ANSI/控制字符不能由模型/工具文本注入终端控制状态。
- 新依赖使用 Cargo lock，遵守 unsafe deny、400 行文件边界和 crate 依赖方向。采用成熟终端库（如 ratatui/crossterm）而非手写第二套业务协议。root 参数实现应避免同时维护两套冲突解析器。

## 必须覆盖的验收

1. 参数：help/version 无 TTY 也退出成功；无参数/tui 需要 TTY，无 TTY 返回清楚错误而不是挂起或开 GUI；cwd/resume/mode/config/data-dir 路径保留，headless/app-server 回归。
2. 状态投影/编辑器单测：Unicode 插入删除/移动/多行/粘贴、滚动/resize、流式文本、工具结果/错误、跨 session/turn 隔离、终端控制字符清理。
3. 真实 PTY + loopback 模型：启动真实 Rust binary，多轮消息真实响应，执行 Read 并核对文件 marker；session ID 持久且新进程 continue/resume 可读/续写，非模拟 UI 成功帧。
4. 权限/询问：用户允许/拒绝进入原有 command，默认不自动放行；用真实 runtime 或严格 transport fixture 验证关联 id。取消慢回复后可继续新一轮。
5. 退出/信号/异常：root 在 TUI 所有返回路径发送 Eof，失败/外部 SIGTERM/SIGHUP/SIGINT 同时 cancel；drain 与 actor 收尾后 PTY termios/raw/alternate screen 恢复、无遗留 workspace lock；信号码为 143/129/130，raw Ctrl-C 由 frontend 处理不重复转发；不以超时掩盖同步问题。非 TTY 参数测试必须确保不触库。
6. 定向 Cargo tests、workspace tests/locked check/clippy/fmt/边界、CLI Node/Rust 差分回归、Desktop --cli 原生入口及原 GUI smoke；Windows/macOS 编译与运行证据分开报告。
