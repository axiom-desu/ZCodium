# 上游 3.17.1 / 3.17.2 语义同步

## 来源与交付边界

用户要求核对 PR、整理分支并跟进 `git@github.com:zai-org/ZCode.git` 的 3.17.2。
基线为已合并 PR #90 的 `origin/main`（`e5346dec`，3.16.2）。

| 版本                 | 公开提交                                   | Source-Commit                              |
| -------------------- | ------------------------------------------ | ------------------------------------------ |
| 3.16.2（旧对账基准） | `3c5b227649371507ddc4eb46ac5133afe6db1cab` | `5a082039a1a3b1edfe8364a33c8978689c0d68bf` |
| 3.17.1               | `a60ba6a7e5a06742270ca605f5d2cc2766afa7e1` | `73158b64ace2c753b67e77e1f83bbaca31b43944` |
| 3.17.2               | `a9fe401eede6e6e5e01be9048679c206fe6f02d9` | `84aed26c781e3ba08e15f22b00370b3564614489` |

先按 3.17.1 主体再叠加 3.17.2 最终语义，不整体 merge 上游、不覆盖本仓重构。
上游镜像本批大规模移除包级单测；本仓保留现有测试、门禁和公开测试入口，不跟随裁剪。
GitHub compare 的 files 仅前 300 项，不能作为完整差异；以本地精确提交的完整树与 git diff 为准。
版本号仅在全部适用行为对账并验收后统一更新；首批窄修不代表完整版本对齐。

## 分支整理（已完成）

- GitHub 核对 PR #82–#90 均为 MERGED，无 open PR。
- 逐分支 `git cherry origin/main <branch>` 均无 `+` 后，删除这 9 个已合并本地分支；远端旧分支已删除。
- `main` fast-forward 到 `e5346dec`，新分支 `feat/upstream-3.17.2-sync` 从此创建。
- `proposal/startup-animation-redesign` 有未合并补丁，保留；不重置、不删除。

## 不变量与所有者

- accepted input 仍由 CLI/runtime CommandInbox 串行 admission；持久化、ACK、终态与 stale-run 边界不变。
- workspace key 仍为 `workspaceIdentity?.trim() || workspacePath`；远端同时传 identity 与 remoteSessionId。
- 每窗口唯一 Local Host 与远端连接 registry 不变。Main/relay 只做调度转发，不成为业务状态所有者。
- Desktop continuous 与手机 replayable 使用同一业务 owner，但各自保留交付、重放与 attachment 生命周期。
- TS / Rust 重写能力的适用变化须双侧同步；不能以“没有同名文件”判定 Rust 不适用。
- 不恢复本仓已移除的 off-peak、归因遥测、request-auth/highspeed 分叉和内部依赖；新增插件/协议另行审查。
- 文件/网络 IO 异步；跨包通过公开入口。原始 lint 不增加 warning/error，不放宽架构或棘轮基线。
- 测试只使用临时 HOME/XDG/data/DB/workspace 与 loopback，不读真实用户数据或 logs，不替换本机安装包。

```text
远端命令 → 现有 backend（唯一连接 owner）→ 真实 exit/signal → 成功/失败判定
RPC 帧 → 头部路由 → 唯一对应 client/server 解码 body → 调用/事件/订阅失败
mobile attachment → Host 显式服务/方法授权 → 原服务 owner → replayable 交付
Desktop attachment → 原完整服务面 → 原服务 owner → continuous 交付
```

## 首批可独立验收切片

每片须先补子 spec 与回归测试，再修改实现；具体规则和证据由各子 spec 记录。

| 切片                        | 上游来源                                                                                                  | 本仓落点与边界                                                                                                   | 当前状态 |
| --------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------- |
| P1 RPC 兼容/二进制/订阅失败 | `packages/rpc/src/{channelClient,channelServer,channels.shared,serialization}.ts`                         | 原 RPC client/server/serializer，保留框架日志注入和现有错误字段；不新增业务 owner                                | 待实现   |
| P2 SSH/WSL/Docker 正确性    | `packages/server/src/remote/*`                                                                            | 原 backend 连接 owner；真实失败退出码、认证诊断、在途取消、身份探测、平台错误与诊断；不改连接 registry 架构      | 待实现   |
| P3 手机 attachment 授权     | `packages/desktop/src/host/windowHostAttachmentRpcPolicy.ts` 与 Host 接线                                 | 本仓 ServiceCollection/Host attachment，默认拒绝未审查 channel；保留手机现有功能及 terminal 生命周期，桌面不受限 | 待实现   |
| P4 Provider 兼容窄修        | `packages/provider/src/resolver.ts`、`packages/provider-node/src/zcode-builtin-provider-config-source.ts` | 原 resolver 与配置源：仅展示 logo 补全、bundled 缺文件恢复；不新增请求行为或另一个配置权威                       | 待实现   |

P4 不隐式采用上游对 HTTP 下载地址的安全准入放宽；该变化须与本仓原安全政策单独对齐。
P3 若需新增 terminal 页面 owner 协议，必须先明确兼容字段与实际手机生命周期；不能擅自用 attachment 换代删除仍在使用的页面终端。

## 全量待对账账单（尚未交付）

下面是源码调查归并的行为簇，不是已完成清单：

| 域            | 待同步行为                                                                                    | 关键所有者/前置                                                            |
| ------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| CLI 上下文    | 请求前公告、环境/模型/Git/date、Plan 五阶段、静默提醒、工具结果投影、服务端内置工具           | runtime 提交历史唯一事实；TS/Rust、冷恢复/compact/rewind 同步验收          |
| CLI 生命周期  | create/resume/close/restart 串行化、分级释放、MCP 信任及连接池取消                            | 复用现有 admission 与 runtime；不得并列生命周期 owner                      |
| CLI 工具/模型 | 命令 shell 块交给 Bash、权限/Explore/Plan、Read/Hook、重试分类、批次事务                      | TS/Rust 适用能力；真实 loopback 与 SQLite 验收                             |
| CLI 插件      | node/npm/npx shim、官方命令端点、site 插件、node-repl broker、Office 容量/共享、DWF 修正      | 新依赖/许可证/SEA 闭包、协议和受控模块先审查                               |
| 数据同步      | user scope 分类中心、CAS 覆盖/冲突、设备 scope、provider provisioning 状态/重试               | 目标服务唯一写入 owner；本机同步状态不得暴露给手机/远端                    |
| 项目管理      | 项目管理视图、恢复、彻底删除数据与 session-data measure/purge                                 | 本仓 project/project-storage/session 端口；远端入口归属差异先定边界        |
| UI            | 个性化指令、文件外部打开/另存、图片编辑、插件后台/嵌套 frame、会话查找/渲染、终端/输入/文件树 | 遵守 DESIGN/平台接口/hooks；新增交互实际 E2E                               |
| 远端设备      | stop/restart/任务清单、显式降级、启动/握手/守护恢复、transport 最后持有者释放                 | 本仓 windowRemoteConnectionRegistry 是连接 owner；不直接导入第二个 manager |
| 远端目录      | 准备截止+单飞、Main 较晚兜底、取消后禁止登记身份                                              | 连接实例+路径为单飞 key；不缓存结果、不以超时掩盖同步错误                  |
| 手机远控      | push/log/actions/恢复与协议兼容                                                               | 适配本仓 webRemoteControl/LAN/relay，不盲导入上游另一套 relay              |
| 发布治理      | Electron44/Builder/PTY 闭包、依赖/许可证/生成资产与版本                                       | 单独跨平台构建验证；不删除本仓测试或放宽门禁                               |

### 需要先对齐的架构边界

1. 设备级 stop/restart 的 flight、恢复意图、最后 transport 持有者应依附本仓 registry，不能直接平行引入上游连接 manager。
2. 上游远端项目 entry/membership 与本仓 project 整合结构不同，彻底删除数据、移除入口和恢复项目必须区分；未明确前不添加破坏性入口。
3. 输入预测、官方命令代理和 site 插件属于新增能力，不能作为“只是补丁同步”无规格地搬运；已移除遥测不恢复。

## 验收纪律

必须实际执行 root `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`，并运行各片目标测试。
格式与棘轮使用当前仓库入口；报告真实错误，不把存量失败写成通过。
Node 以 `mise.toml` 的 24.14.0 为准；环境只有其他版本时记录限制，不修改 pin 来绕过验证。
最终版本对齐另须完整 root/workspace、Rust workspace/clippy/fmt/边界、生成资产、许可证、PTY、互操作、Desktop/Web/手机回归与精确 PR HEAD CI。

## 首批交付状态与遗留

已交付并实测（Node 24.14.0，仓库 pin）：P1、P2、P3、P4-logo，外加用户追加的远端首次连接修复
（`remote-first-connect-usability.md`：R1 打包/版本、R2 制品链、R3 starting daemon、以及可复跑首启冒烟）。

汇总验证：root `pnpm typecheck` 通过、`pnpm lint` 0/0、`pnpm architecture:check --changed` 0 violation；
`vitest run packages/rpc packages/provider packages/provider-node packages/shared/src/source-server
packages/server/src packages/zcode-server-cli/test` 29 files / 265 passed；Desktop host 目标 6 files / 65 passed；
`scripts/ci` prepare/bundle/offline-deploy 18 passed；`pnpm test:source-server-first-connect` 全链路通过。

仍开放（不写成已对齐）：

- Provider Bundled 缺文件回退需先定义「可写 bundled 副本」的失效语义，不能用模块级缓存变成第二配置权威；
- 手机 Terminal 页面 owner 隔离：本次只收口频道授权，没有新增 owner 协议或换代回收；
- 表格中的 CLI 上下文/生命周期/数据同步/项目管理/UI/远端设备等大面仍未同步；
- 版本号按本仓惯例（同步到哪个上游版本就滚到哪个）与用户明确要求，滚动为 `3.17.2`，
  构建版本串为 `3.17.2-<date>.<count>`；这**表示版本面对齐上游 3.17.2，不表示下表行为面已全部同步**。
  对外描述必须同时给出「已移植 / 未移植」范围，不得用版本号暗示完整功能对齐。

## 3.17.2 版本滚动的准确口径（供发布说明与后续对账）

已移植（有目标测试与真实链路证据）：RPC 帧/错误/二进制/订阅失败；SSH·WSL·Docker 后端正确性与
诊断错误码；手机 attachment 频道授权收口；Provider 展示 logo 补齐；远端首次连接链路
（Server CLI 打包与版本注入、R3 制品生成/打包/解析、`serve --daemon` starting 就绪）。

未移植（因此不得宣称「3.17.2 功能完整」）：CLI 请求前公告与隐藏提醒持久化、Provider 投影与服务端
内置工具、Session 生命周期单 owner、MCP 信任与连接池、数据同步中心（user-config-sync / 设备 scope /
provider provisioning 状态）、项目管理与彻底删除数据、设置页个性化、文件外部打开/图片编辑、
plugin-ui 后台保留、远端设备 stop/restart 与显式降级、手机 relay v2 与输入预测、office/site 插件、
Dependency 升级（Electron 44 / builder 26.17 / node-pty 平台包）与对应生成资产。

因此下一轮工作仍按本文件 §全量待对账账单 推进；每完成一簇再更新本清单，而不是靠改版本号推进。
