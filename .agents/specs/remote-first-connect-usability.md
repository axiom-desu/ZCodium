# 远端首次连接可用性修复

## 用户诉求与证据边界

在 3.17 同步期间用户补充反馈「远程压根没法正常工作」，明确要求修复。当前尚缺用户连接方式、安装版本、系统和界面错误；不能将下面源码复现的缺陷冒充用户现场根因。

已在当前源码的隔离环境确认：

1. 生产 prepare/bundle 链仍以旧组件 manifest 为中心，没有生成并随包提供 Host resolver 所需的 R3 `source-server-release.json`；干净安装在确认安装后缺少 release 来源。
2. Server CLI ESM bundle 的 `node:` builtins 与 CJS zip 库处理不完整，真实产物执行 `--version --json` 即崩溃。
3. Server CLI 未注入产品版本，实际构建输出 `0.0.0-dev`，与 Desktop 3.16.2 的严格兼容门禁冲突。
4. `serve --daemon --json` 复用现有 starting Supervisor 时直接成功返回 `port:null`，下游 adapter 无 ingress port。

## 产品规则和单一所有者

- 远程首次连接必须用本仓公开构建/准备入口产生的真实、完整、可安装制品；不能要求用户手工构造 release descriptor 才能使用既有 SSH/WSL/Docker 入口。
- R3 immutable release / resolver 是唯一发布描述和安装来源，不添加另一套 legacy 部署旁路。
- prepare/bundle 只生产静态分发资产，不持业务状态；Host registry 仍拥有物理连接与已鉴权 Source identity。
- release 的产品版本来自根 package.json / 既有版本注入源，CLI/Supervisor/Core/Host 握手一致；不放宽兼容门禁、不伪造 ready 或升级成功。
- `serve --daemon` 只有真实 ready 且有合法 ingress 时可成功，starting 走既有 readiness 等待，等待超时如实失败；不靠 sleep 或更长超时掩盖错误。
- scope/lease/generation、Desktop continuous 与手机 replayable、commit-before-ACK、remote identity 隔离不变；不将用户数据、凭据或本机环境写入制品。
- 本仓保留已移除内部依赖与其他产品能力的边界；打包必须覆盖本仓实际新增依赖（例如 yauzl），不能只搬上游部分修正。

```text
公开 prepare/build → R3 descriptor + 对应 immutable archive（完整依赖/Agent/Node）
 → Desktop bundle 复制同一资产 → Host resolver 校验目标/版本/hash
 → 用户确认 → transport 上传/安装 → Server CLI（真实产品版本）
 → Supervisor/Core readiness → ingress + 鉴权握手
 → 原 registry descriptor → 目录准备/bind → 原 Agent runtime
```

## 实施切片

### R1 Server CLI 真实产物

先更新打包/发布相关子规格与测试，再修 `tsup.config`、构建依赖闭包和版本注入。
测试必须 fresh build 后直接执行 bundle 的 `--version --json`，不能只断言 config 字符串，也不能依赖源码 tsx 绕过产物。
还须验证实际打包后的 server-core 入口，不只顶层 CLI；保留现有 agent bytecode/stdio 路径、只读 bundled provider 与公共导出别名。
完成情况：`tsup.config.ts` 现保留 `node:` 前缀、external `yazl`/`yauzl`，并注入滚动版本；
fresh 构建产物经 staging 后真实执行 `--version --json` 得到 `3.16.2-20261031.427`（非 `0.0.0-dev`）。

### R2 R3 prepare / bundle / resolver 接线

先调查当前源码真实发布机制，复用 `packages/zcode-server-cli` 的 packaging/release descriptor 规则，补上生成、随包复制和 Host 路径消费。
先补从公开 prepare 配置到 Host resolver 的集成测试，再实现。缺平台制品/Node/Agent 必须清楚失败，不生成虚假可用 descriptor；hash/target/版本/安全相对路径验证不得省略。
开发模式与最终安装目录均能解析到同一格式，跨 Windows/macOS/Linux 不硬编码 POSIX 安装路径。
不触发真实发布、打 tag、下载不必要全平台制品或改本机已安装应用。
完成情况：闭包修复见 `remote-first-connect-r2-assets.md`；`node-repl-host` 与其 CUA runtime
现由 packaging owner 正确装配，组件路径使用真实目录名。

### R3 starting daemon 复用

`serve --daemon` 的现存 Supervisor starting 状态须等 ready，不直接使用 port:null。
沿现有 control/readiness owner 等待，临时 control socket barrier 验证 starting→ready、starting→failed、超时和取消，保留原有终态/锁语义。
完成情况：`serve --daemon` 复用 starting 时等待真实 ready 与合法 ingress port，见
`remote-first-connect-server-cli.md` 与 `daemonReadiness.test.ts`。

## 验收

- 先红后绿的目标回归，全部临时 HOME/XDG/data/root 与 loopback，无真实远端/凭据/用户日志。
- fresh Server CLI bundle 执行版本命令和 server-core 首启。
- 公开 prepare/bundle 的 R3 资产与 Host resolver 贯通；至少本机 target 的真实 archive→临时安装→daemon ready→server-info→Host RPC→Agent 首次消息 loopback。
- 必须区分「产物启动/握手通过」与「真实 SSH/WSL/Docker 用户环境通过」，后者无环境不得声称完成。
- 执行 root typecheck/lint/architecture、格式与目标测试；未通过如实记录。
- 3.17 全量语义同步仍按 `upstream-3.17-sync.md` 账单进行，本修复不代表完整 3.17.2 对齐。

## 可复跑入口与实测结果

入口：`pnpm test:source-server-first-connect`（`scripts/ci/source-server-first-connect-smoke.mjs`）。
入口自身在加载业务模块前建立临时 HOME/XDG/应用数据/Server root，全部子进程继承同一隔离环境，
结束时 stop daemon 并删除临时目录；不读取真实用户数据、日志或凭据，不连真实远端。

2026-11-08 在 Node 24.14.0（仓库 pin）实跑通过，版本 `3.16.2-20261031.427`：

1. fresh tsup 构建 server-cli；
2. 真实 Node/搜索工具/全部内置插件（含 CUA）+ 真实 Agent bundle 作为公开 prepare 输入；
3. 公开 prepare 生成 R3 descriptor + 122MB 归档，hash 与 descriptor 一致；
4. staging 后 CLI 在自带 node_modules 闭包下真实执行并报告正确版本；
5. 公开 bundle + verify 通过，Host resolver 从随包目录解析到同一归档；
6. 解包 → `update --from-archive` → `serve --daemon` 得到 `ready` 且 port>0；
7. Bearer 鉴权的 server-info 返回身份/工作区；匿名请求只得到降级描述；
8. Host RPC `fileService.readdir` 读到远端工作区文件；
9. 随包 Agent `--version` 可执行；daemon 正常 stop。

仍未覆盖（不得写成已通过）：真实 SSH/WSL/Docker 目标、Agent 首条模型消息、Windows/macOS 制品。

## 汇总验证

- `pnpm typecheck` 通过；`pnpm lint` 0 warning / 0 error；`pnpm architecture:check --changed` 0 violation / 0 baseline / 0 new。
- `vitest run packages/rpc packages/provider packages/provider-node packages/shared/src/source-server packages/server/src packages/zcode-server-cli/test`：29 files / 265 passed。
- Desktop host 目标用例：6 files / 65 passed。
- `scripts/ci` prepare/bundle/offline-deploy 目标：18 passed。
- 改动文件 `oxfmt --check` 通过，`git diff --check` 通过；未放宽任何棘轮/架构基线。

## 3.16.3 本地发行构建（供手机远控复验）

- 根版本由 `3.16.2` 升到 `3.16.3`；`scripts/ci/desktop-release.mjs check-version` 通过，
  派生版本为 `3.16.3-20261031.427`（滚动版本，app/asar/server CLI 一致）。
- 由于本机缺少 `rpmbuild`，本次只出 AppImage 与 deb（`ZCODE_DESKTOP_LINUX_TARGETS=AppImage,deb`）。
  发布工作流不设该变量，仍按完整列表出包；本地产物不能宣称覆盖 rpm/pacman。
- 产物（`packages/desktop/dist/`）：
  - `ZCodium Exp-3.16.3-20261031.427-linux-x86_64.AppImage`
  - `ZCodium Exp-3.16.3-20261031.427-linux-amd64.deb`
- 打包后复核：`resources/web-remote/mobile.html` 与 `mobile-*.js` 存在；`resources/remote-assets/releases/
3.16.3-20261031.427/source-server-release.json` 与其归档同版本；归档内包含
  `node-repl-host/dist/mcp/server.js` 及 CUA 闭包（`@trycua/cua-driver`、`@ubjs/*`）；
  `app.asar` 内 `@zcode/desktop` 版本为 `3.16.3-20261031.427`；
  `verify-runtime-dependencies` 通过，`.deb` 体积 354.7 MiB（上限 500 MiB）。
- 未签名（`CSC_IDENTITY_AUTO_DISCOVERY=false`），仅用于本机自测；未安装到本机 `/opt`，未打 tag 或发布。

## 手机远控相关结论（证据边界）

手机远控的 RPC 面经 `RemoteServiceAccess` + Host attachment 授权：`file/media/preview/system/terminal/
git/git-checkpoint/setting/onboarding/credential/cua/broadcast/task/window-controller/agent/session/project/
file-watcher/provider-settings/model-selection/usage/coding-plan/client-scenes/skills/plugins/plugin-management/
subagents/commands/hooks/memory/settings-sync/bots/prompt-attachment-transfer` 均放行；`gen-ui` 只放行
`listState`；`mcp-sync` 只放行手机现用三个方法；`skill-sync`/`plugin-sync`/`source-server-management`/
`provider-provisioning-target`/plugin-ui-\* 不发布。`mobile-project-directory` 与手机分享、任务 guard 仍由
Host 显式注册与包装，不经过 allowlist。

未复现用户报告的「完全不能用」：本机无法连真实手机与真实桌面 LAN 会话，也没有用户的界面错误原文。
下次复验请提供连接方式（LAN/中继）、卡在哪一步与错误文案，再据证据收敛，不靠猜测扩大改动。
