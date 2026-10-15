# M8 真实 Electron 最小 E2E 脚本

本 spec 描述 `scripts/zcode-cli-rust-desktop-smoke.mjs` 这一条桌面 E2E 链路的边界、
状态所有者、网络策略、事件顺序与清理契约。它只服务 `.agents/specs/cli-rust-m8-desktop.md`
验收 5（Electron 真机最小闭环），不替代 Rust worker 的 `--prepare-storage` 进程级验收，
也不替代 services/desktop 的单元与集成验收。

## 目标与唯一所有者

- 唯一入口：`scripts/zcode-cli-rust-desktop-smoke.mjs`。
- 辅助模块（仅本链路使用）：
  - `scripts/lib/zcode-cli-rust-desktop-build.mjs`：本轮桌面 `tsup`+`vite` 构建。
  - `scripts/lib/zcode-cli-rust-desktop-env.mjs`：隔离 HOME/userData/sessionData/XDG/DATA_BASE
    与 E2E run id，白名单化子进程环境。
  - `scripts/lib/zcode-cli-rust-desktop-network.mjs`：fail-closed 本地代理 + 凭据作用域收紧。
  - `scripts/lib/zcode-cli-rust-desktop-app.mjs`：用现有 `playwright-core` 的 `_electron`
    启动/关闭真实 App，并通过真实 UI 元素驱动。
- 复用既有 fixture：`scripts/lib/zcode-cli-rust-interop-fixture.mjs` 的 `modelServer`/`prepareHome`
  是本链路唯一的本地模型 owner；脚本不再自建第二个 mock server、不伪造 ACK、不写假帧。
- 本链路不新增 services/desktop 运行时代码；UI 驱动只走 `packages/ui` 已注册的
  build-time `VITE_ZCODE_E2E_STORE_BRIDGE` 桥接与 `data-testid` 真实元素。

## 隔离边界（每次运行独立）

```text
mkdtemp(zcode-m8-desktop-<runId>)
├── home/            HOME / USERPROFILE / ZCODE_DESKTOP_HOME_DIR
├── user-data/       ZCODE_DESKTOP_USER_DATA_DIR
├── session-data/    ZCODE_DESKTOP_SESSION_DATA_DIR
├── xdg-config|data|cache|state/
├── data-base/       ZCODE_DATA_BASE_DIR（.zcodium 数据根）
├── storage/         ZCODE_STORAGE_DIR（CLI 存储根）
├── db.sqlite        ZCODE_SESSION_DB_PATH（CLI session 库）
├── builtin.json / personal.json（fixture provider registry）
└── artifacts/
```

- `ZCODE_DESKTOP_APPLICATION_NAME` 每个 run 唯一，避免 Electron 单实例锁命中用户已有 App。
- `ZCODE_E2E_RUN_ID` 唯一，满足 `shouldEnableE2ETestBridge` 的 build flag + run id 双条件。
- 环境从白名单构造：只透传 `PATH/TMPDIR/TEMP/TMP/LANG/LC_*/DISPLAY/XAUTHORITY/XDG_RUNTIME_DIR/
DBUS_SESSION_BUS_ADDRESS/WAYLAND_DISPLAY` 与本链路显式变量；不继承用户 `ZCODE_*`、
  provider key、代理或云凭据。
- legacy 迁移：临时 HOME 与数据根均为空，`migrateLegacyUserDataRoot` 与 userData 改名迁移
  天然无 legacy 可搬；脚本在结果中记录“未发生迁移”，不预置任何 `.zcode`/`.zcodium` 旧根。
- 不删除、不读取、不操作用户真实 App 的 userData/数据根，也不下载依赖。

## 网络策略（fail closed，精确限定）

模型请求必须命中 `127.0.0.1` 上的 fixture；其余主/renderer 出网一律阻断。

- 渲染进程：`BrowserContext.route` 只放行 `file:`、`data:`、`blob:`、`devtools:`、
  `zcode-sandbox:`、`127.0.0.1`、`localhost`，其余 `abort` 并记录 URL。
- Chromium 网络（main+renderer）：启动参数
  `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost` 与
  `--proxy-server=127.0.0.1:<fail-closed proxy>`、`--proxy-bypass-list=127.0.0.1;localhost`。
- 本地代理只接受 loopback 目标，非 loopback 一律 403/断开并记录 host，形成“所有出网都要过
  代理或直接失败”的闭环。
- Node 侧（host/agent）通过 `ZCODE_HTTP_PROXY` + `NO_PROXY=127.0.0.1,localhost` 走同一代理；
  该键不在 `sanitizeZCodeRuntimeEnv` 剔除列表中，能到达 CLI。主进程 undici 不保证读环境代理，
  因此 Node 直连属于“尽力而为”，脚本在 `network.limitations` 中如实标注，不把 Chromium 的
  代理与 Node 直连混为一谈。
- 不写入、不读取真实凭据；`.env.development` 仅含 loopback 信任源，不含密钥。

## 事件顺序（唯一路径）

```text
1. 构建：clean out → tsup(main/host/preload/scheduler/plugin-sandbox) ∥ vite build(renderer,
   VITE_ZCODE_E2E_STORE_BRIDGE=1) → 落 out/.{main,host,preload}-build-ready
2. 起 fixture：modelServer(127.0.0.1) → prepareHome(root, baseUrl) → 得到 provider env
3. launch(runtime=zcode-cli-rust)：_electron + 隔离 env + 网络守卫
4. 数据库 ready：等 [data-testid=v4-composer-input] 可见；若出现
   database-startup-status[data-phase=failed] 立即记录 errorCode 并以明确阻碍结束
5. 创建会话 + 模型文本：向 v4-composer-input 输入唯一串 → 点 v4-composer-send →
   等 v4-timeline 文本包含 model fixture 的 `answer: <串>`
6. 可选工具：输入 “use tool” → 等 Read 工具调用块（TID_CHAT_TOOL_CALL_BLOCK 前缀）出现
7. 重启切 TS：关闭整棵 Electron 进程树 → 用同一 HOME/DB、runtime=ts 重新 launch →
   等同一会话文本恢复（验证唯一库 owner 由 CLI 持有，切换 runtime 不复制 runtime）
8. 结果：写 artifacts/m8-desktop-smoke.json 并打印摘要；finally 关闭 App、模型、代理并
   删除临时根目录（--keep 时保留并打印路径）
```

## 状态所有者与幂等

- 会话与存储状态的唯一 owner 是 CLI runtime + Host 的 `prepareSessionStorage`；本脚本只观察，
  不持有第二份 accepted 队列、不重放、不写启动状态。
- Electron 进程树使用独立进程组，关停先 SIGTERM 后 SIGKILL，保证 agent/host 子进程与
  fixture/model 连接都被回收，端口与临时目录 finally 清理。
- 重启用例只断言“同库可读”，不假设 Rust/TS 同时持锁。

## 验收与未覆盖边界

- 通过：真实 App 窗口 + 数据库 ready + 创建会话 + 模型文本 + （时间允许）工具与切 TS 恢复，
  全部来自真实 runtime 与本地 fixture，无自造 ACK。
- 若本机原生依赖/构建/图形环境或上游 worker 未就绪导致启动失败，脚本以非零退出并输出
  `blockers[]` 精确原因，绝不把 headless 服务集成或旧 `out/` 产物称为真实 App E2E。
- 不在本链路内：Windows/macOS 原生证据、并发 mixed-runtime owner 协调、默认 Rust 启用、
  MCP OAuth/CUA/REPL/memory 产品补齐。
