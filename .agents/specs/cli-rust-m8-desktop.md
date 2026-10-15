# M8：显式 Rust 桌面最小闭环

## 产品规则与边界（实现前约定）

后续产品决策覆盖原双向要求：Rust 单向接管 TS 库并最终替代 TS；Rust→TS 恢复不再作为必过项。必须验证 TS 历史会话的读取/中断恢复/续写与数据保全；先停止 TS owner，再启动 Rust。随后用户另行授权 ZCodium Rust 打包口味默认 Rust，见 [产品默认规则](cli-rust-preview-default.md)；仍不授权访问用户库。

- 打包 preview（ZCodium Rust）默认 Rust；production（ZCodium Exp）与未打包开发态默认 TS。Main 注入产品默认，非空显式 `ZCODE_AGENT_SERVER_RUNTIME=ts|zcode-cli-rust` 优先；空值使用产品默认，未知值明确失败。显式 `ZCODE_AGENT_SERVER_COMMAND` 保留最高优先级与既有自定义命令语义，不臆测其存储能力。
- Preview 按构建 flavor 分发并默认启用 Rust，不以文件是否存在决定默认。显式 Rust 缺 binary 必须失败，不回退 TS；撤销选择或设为 ts 才是回退。
- Services command resolver 是 runtime 选择/能力描述的唯一 owner。开发环境允许发现本仓当前 Cargo target/debug（后备 release），打包态优先 resources/rust；不能仅按 cwd 命中任意同名外部程序。
- `ZCodeAgentCommand.storagePreparationEntry` 改成唯一 tagged descriptor `storagePreparation?: {kind:'node-worker';entry:string} | {kind:'native-process'}`。前者运行已知 JS 存储 Worker，后者复用 resolved command/args/cwd/env 启动原生进程并追加 `--prepare-storage --cwd …`。`supportsStorageStartup` 仍说明常规 Agent 会发合法启动状态；未知自定义/旧部署命令不推断能力。开发 tap wrapper 保留该描述。
- Host 复用同一控制帧解析、pathReady、observePath、preparedPaths、迁移失败报告，不为 Rust另建存储状态。native 只替换 transport，不改变 UI/platform API、schema 或 accepted queue。
- CLI 才能开库/迁移；Rust 必须在收到合法 `startup/storagePathReady` 后才开 NodeStore。`reuse:true` 只复用 Host 本轮已成功关闭的库，跳过再次开库，不持久化 skip 标记；不能绕过正常 app-server 启动检查或 workspace owner 锁。
- stdin EOF / Host abort 必须终止准备进程并等待退出，失败/未prepared/非零退出不得缓存 prepared path；正常退出先确认 stdout 已排空。native 使用既有跨平台进程树清理接口，不放任持锁孤儿。异常退出与 SIGKILL 下的父进程存活边界须如实记录。
- 不修改默认存储路径、历史 SQL、用户库；测试只临时 HOME/DB/workspace、本地 mock，无真实凭据。不得通过加 fallback 绕开 unsupported gate。

## 所有者与顺序

```text
main → window-scoped Host / DatabaseStartupCoordinator（唯一启动状态 owner）
  → Services resolver（显式 runtime + transport capability）
  → Host prepareSessionStorage（唯一 path reuse / handshake owner）
       ├─ TS: node-worker
       └─ Rust: native-process
            storagePath → observePath → pathReady(reuse)
               → CLI 单一路径开库/迁移（reuse则不再开）→ state ready
               → store关闭 → storagePrepared → stdout drain → exit0
  → Host 启动服务 → 既有 ProcessManager.spawn / ZCodeStdioTransport
  → 同一 Core owner / lease → durable commit → ACK + V4 frame
Desktop continuous ─ live ─────────┐
Web replayable ─ snapshot/replay ──┴─ 仍是同一会话 owner，不复制 runtime
```

## 验收要求（未执行不写成通过）

1. Resolver：默认/ts 不选随包 Rust；显式 Rust 在有 TS bundle 时仍命中；缺 binary/未知值失败；custom command 优先；Rust descriptor 无 Electron Node env；TS worker 保留。实际执行行为断言，不仅源码字符串。
2. Host transport：Node Worker 与 native 共享握手验证；ready/prepared/exit0 才成功；abort、invalid/duplicate path、prepared-before-path、observePath失败、failed帧、非零退出、未prepared均失败且清理；同真实路径 reuse、失败不缓存。
3. Rust 进程：真实 binary `--prepare-storage`、合法/非法握手、reuse不再写/迁移、库打开错误，临时目录验证输出schema与退出码。
4. 集成：真实 Host prepareSessionStorage + Services resolver + ProcessManager/ZCodeProtocolClient 连接 Rust；创建会话、订阅桌面profile、受控模型文本、文件工具、退出清理；用 TS 生成的临时历史库（已完成与中断场景）由 Rust 读取/恢复并续写，比较历史内容与必要状态、检查旧数据保全。禁止自造ACK代替真实runtime；不要求切回 TS。
5. Electron：在隔离 HOME/userData/sessionData/XDG 下启动本轮构建的真实 App，完成数据库启动、基础对话/工具可见；若本机原生依赖/构建/图形环境受阻，精确报告，不能把headless服务集成称为真实App E2E。不操作用户已有App，不下载依赖或访问真实服务。
6. 全仓 typecheck/lint/architecture、Rust checks/tests、driver tests与可用Desktop检查真实执行。Windows/macOS需原生运行证据，Linux不代替。

## 尚未授权扩展

MCP OAuth/CUA/REPL/memory 完整产品补齐、mixed-runtime 同workspace并发owner协调、正式版默认 Rust 与发布切换不在最小闭环内；仅 ZCodium Rust 打包口味默认 Rust 已获单独授权。
