# Desktop executable：统一 `--cli` 入口

## 产品规则（实现前确认）

- 用户确认桌面可执行程序提供 `zcodium-exp --cli …` / `zcodium-rust --cli …`；没有 CLI 标记时仍走原 GUI，已有工作区/deep link/单实例行为不变。
- 仅消费 argv 首位置的顶层 `--cli`，后续参数、空串、`--`、cwd、stdin/stdout/stderr 原样交给所选 CLI；不把 prompt 中的 `--cli` 当路由，不在 Desktop 重做 CLI 参数解析。开发态 Electron `process.defaultApp` 为真时，先剥离 Electron 注入的 appPath，再检查首个参数。CLI 帮助、错误、退出码均来自 CLI，不再错误打开 GUI。
- 已打包 production 默认 TypeScript CLI（包含真正的 TUI 资产），已打包 preview 默认 Rust CLI；开发态默认 TS。显式 selector 去除首尾空白并忽略大小写；空值按默认，未知值明确失败。缺少物料由 exec/spawn 的标准启动错误明确失败，不自动跨语言回退。`ZCODE_AGENT_SERVER_COMMAND` 是 Host app-server 路由，不用于替换公共 CLI 入口。
- 初始 Rust TUI 占位的诊断边界由后续用户要求扩展为真正终端前端，见 `cli-rust-terminal-ui.md`；不能靠调用 TS TUI 冒充 Rust 交互。
- 不要求系统 Node；TS CLI 由同一个 Electron 可执行程序以 `ELECTRON_RUN_AS_NODE=1` 执行随包 JS，原 app-server 路径保持不变。CLI/TUI 物料独立于 GUI 初始化，不加载 renderer、Host 或 GUI session store。

## 唯一所有者和接口

```text
OS executable → light Main bootstrap（仅 Node 内置模块）
  ├─ 非 --cli → dynamic import 原 GUI Main（原初始化顺序/单实例逻辑）
  └─ --cli → product default / explicit selector → CLI execution plan
       ├─ TS：Electron Node + resources/glm/zcode.cjs + 同平台 TUI 闭包
       └─ Rust：resources/rust/zcode-cli-rust
             → 原 CLI session/runtime/CommandInbox 所有者
```

- Main bootstrap 是公共启动分流唯一所有者，必须先于原 Main 的静态副作用导入；不向 Services 引入桌面 identity，也不在 GUI Main 的 imports 之后补判断。
- TS TUI 物料复用已有 `collectSeaTuiAssets` 的依赖闭包、workspace manifest 重写、平台 native 筛选；TUI 已由 esbuild 内联的 workspace 依赖以构建时产出的 external-dependency manifest 为准，不再把已内联/类型依赖当作必须存在的独立 dist。该 manifest 必须来自本轮构建并校验 schema，缺失即要求重建，不能靠旧 dist 或硬编码免检。仅暂存当前目标平台，位于 `glm/node_modules`。先 stage Agent bundle，再 stage TUI，避免前者清空目录抹掉后者。默认 CLI build 及 Desktop prepare 必须构建其 workspace 依赖，不能靠开发机旧 dist。
- packaged 只消费自己的 resources；开发只从 checkout 锚点的同平台 stage 目录取物料，不按用户 cwd 搜索可执行文件。
- Agent stage 同时携带入口旁的 provider 配置和 notices，公共 CLI 不依赖 GUI Host 的环境注入。Electron Builder 默认忽略资源根的 node_modules，因此 TUI 闭包有独立 extraResources 映射；afterPack 对同平台 manifest 全部文件及 TS 入口/provider 做存在性校验，缺任何物料即中止发布。此处是完整性存在校验，不冒充清理 sourcemap 后的字节签名校验。
- `process.defaultApp` 是开发态判定依据（不能以开发态也存在的 `resourcesPath` 推断已打包）。POSIX 优先使用固定 Electron Node 支持的 `process.execve` 原位替换，原 PID/前台 TTY/信号/退出码直接属于真正 CLI，不引入第二个进程 owner；Windows 使用继承 stdio 的子进程，转发退出和终止信号，不将 signal/null code 当成功，子进程结束后父 Electron 必须退出。启动异常也必须终止 Electron，不能仅设置 `exitCode` 后等待其他活动句柄。无法附着真实 TTY 时交互 CLI 清楚失败；管道/help/headless 仍可用。Windows 控制台与 macOS 签名需由相应 runner/实机验证，不冒充本机 Linux 验收。
- 不改变 workspace identity、CLI 数据路径、owner/lease、协议与 Desktop continuous / 手机 replayable 的业务语义。

## 验收

1. 路由：GUI 参数不变；首个 --cli 被剥离一次，其余 argv/cwd/空串/-- 全保留；production/dev/preview 默认及显式 selector/错误选择/缺物料覆盖。
2. 真实可执行程序：无 DISPLAY/WAYLAND 环境中 `--cli --help`、`--cli -p` 无窗口，stdout 无 GUI 日志；GUI 单实例已运行不抢占 CLI；退出/错误/信号传播正确。
3. TS：随包 Electron Node 实际 import 同平台 `@zcode/tui`，PTY 下打开终端界面、可退出，不能靠系统 Node 或仓库 node_modules。
4. Rust：通过同一可执行入口 help、无头 prompt、PTY 多轮交互与工具；不回退 TS。详见 Rust TUI spec。
5. GUI：真实窗口仍启动并用原 runtime 处理消息；`out/main/index.js`、GUI chunk、ready marker 和所有引用方同步，打包 app 主入口无需用户修改。
6. TS 资产：真实闭包加载、仅目标 native 包、manifest exports、执行权限、失败不留旧/半成物料；六平台映射静态测试，原 native/resource/版本/签名校验保留。
7. 实际执行 typecheck、lint、architecture、定向/CI 测试与可用 E2E，明确未执行平台，不提交临时 profile/截图/二进制/用户 logs。
