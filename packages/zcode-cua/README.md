# @zcode/zcode-cua

ZCode 侧的 Computer Use 运行时适配器。原生执行层复用唯一一个开源项目
[`trycua/cua`](https://github.com/trycua/cua) 的 `@trycua/cua-driver`
（MIT，Rust，macOS / Windows / Linux）。

`createComputerUseRuntime({ client })` 把 driver 接到 ZCode 的
`ComputerUseRuntime` 端口上。client 由上层注入（同进程 TS SDK、daemon
`connect()`、MCP proxy 或测试假件），本包不实现任何平台逻辑，也不缓存窗口、
坐标与剪贴板。

没有注入 client 时，运行时**保持 fail-closed**：每次调用返回一条可操作的错误，
绝不伪造成功。broker RPC、Helper install/launch/verify、PiP session 等旧
接口仍为 API-compatible 占位，权限端口保持 fail-closed 语义。

`frame-contract` 的谓词同样是占位：官方 CUA 帧的真实实现随闭源 producer 一起
未发布，本仓没有任何位置能产出官方帧信封，因此这些谓词恒为否定（`false` /
`undefined` / 原样返回）属于正确否定，不是 bug，不能改成恒真。由此留下两个潜在
fail-open：`apps/zcode-cli` 里「伪造 `image_ref` 剥离」分支永不触发，
`node-repl-host` 的 `keepLatestCuaFrame` 永不去重。如需支持官方 CUA，须按 producer
发布的信封格式实现，不在调用方猜测。

设计与迁移边界见 [`.agents/specs/computer-use-runtime.md`](../../.agents/specs/computer-use-runtime.md)。

## 兼容层（老 GNOME / Wayland）

`compatible/` 只服务 **cua-driver 原生输入不可用**的老 GNOME（Ubuntu 22.04 / GNOME 42，
portal v1 无 libei），用 mutter 直连注入 + WinRects Shell 扩展完成物理输入；
GNOME 45+ 与 Windows/macOS 一律走 cua-driver 原生，不加载它。

- `detect.js` 判定是否适用；`executor.js` 把输入类工具翻译到 `backend.js`。
- `helper/cua-wayland-input.js`（GJS 长驻）只代理 D-Bus 原语，`helper-client.js` 监督它。
- Unicode 走 `Ctrl+Shift+U` 码点，不依赖剪贴板。

契约与验证记录见 [`.agents/specs/computer-use-wayland-input.md`](../../.agents/specs/computer-use-wayland-input.md)。

测试：`pnpm --filter @zcode/zcode-cua test`。

License: Apache-2.0.
