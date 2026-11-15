# 上游 3.18.2 安全加固（S1）：MCP 准入 / 远程写入面 / 远端重绑 / CAS

- 来源：`zai-org/ZCode@fec97590`（3.18.2），区间 `3c5b2276..fec97590`；复核证据
  `WAVE1 对抗式安全复核`（B1/B2/B3/W1/W2/W3/W5）。
- 本片只修已验证的安全问题，不新增能力、不恢复已移除的归因遥测/off-peak/request-auth/highspeed/
  CUA 休眠帧；不建设第二套 runtime、配置缓存或远端 manager。
- 旧行为以本文为准：`upstream-3.18-cli-lifecycle.md` 的 MCP 信任语义、`upstream-3.18-data-sync-ui.md`
  的 CAS 语义由本片收紧；其余条款保持不变。

## 唯一所有者

| 状态 / 边界                                         | 唯一所有者                                            | 约束                                                                                                              |
| --------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 工作区 MCP 声明与授权                               | `createWorkspaceMcpTrust`（bootstrap）                | 声明来自 `createConfig` 的项目来源 + 工作区 `.agents/mcp.json`；授权只写 `security/workspace-mcp-trust-v1.json`。 |
| MCP 执行准入                                        | `guardPort`（bootstrap）                              | 只包既有 `McpPort`；连接前重验，未授权先断开。                                                                    |
| 远程 attachment 可调用方法                          | `exposeWindowHostAttachmentServices`（desktop host）  | 手机/Web 通道显式白名单，方法级默认拒绝；桌面 `desktop-continuous` 不加策略。                                     |
| 远端 logical session 的 workspace 身份 / generation | `windowRemoteConnectionRegistry.bindWorkspaceContext` | 只有准备成功后才提交；失败/取消保留旧 session、旧 attachment、旧 runtime。                                        |
| 配置文件 CAS 读改写                                 | `updateJsonObjectFile`（services/fs）                 | 读、比较、写在同一把 `withAtomicFileLock` 内。                                                                    |
| 用户个性化指令                                      | `ISettingService`（services/setting）                 | 读有界；超限读取不得成为可保存的基线。                                                                            |

## B1 工作区 MCP 信任门（fail closed）

- `.agents/mcp.json` **始终**参与 `discover()` 合并，不因项目标准配置已有条目而跳过；
  同名条目由项目标准配置优先，fallback 不能覆盖项目/用户来源。
- `allows(name, config)` 的默认结果是 `false`：
  - 显式 `source.kind === "plugin" | "builtin" | "user"` 直接准入（原有语义）；
  - 工作区声明必须存在、`enabled !== false`、执行摘要精确匹配且有授权记录；
  - 无声明、无来源、读取/解析失败、未知名字一律拒绝；
  - 用户/系统来源在准入时由 `createConfig` 的 `sources.mcp.serverSources` 显式映射
    （`user/env/cli` → user，`system` → builtin，`project` → workspace），不能靠 `undefined` 兜底。
  - 主代理最终复核：只有名字命中用户配置仍不够。缺省/工作区来源的运行配置必须与
    `createConfig` 当前有效的同名用户/系统配置执行摘要一致且该配置启用；工作区恶意
    `.agents/mcp.json` 不能借同名 `userServer` 绕过审核执行另一条命令。
- 事件顺序：

```text
Host params.mcpServers / agent config
  → guard.connect* 冻结配置
  → authority.allows（discover + 摘要 + 授权记录）
      ├─ true  → raw.connectServer（单次 mutation 队列）
      └─ false → 断开旧连接、标记 untrusted、不连接
  → status/listTools 只暴露已准入项
```

- 不新增 UI 审核入口；`workspace/mcp/trust` 仍只做持久化决定。

## B2 手机/Web 远程 attachment 方法面

- `web-remote-replayable`（mobile 与 web-client）继续使用显式频道 allowlist；
  频道内再按方法收窄，**默认拒绝新方法**：
  - `ISettingService` 只发布 `get`、`update`、`updateDataBaseDir`、`ensureDefaultProject`；
    `getUserInstructions`、`saveUserInstructions` 以及未来新增方法一律拒绝；
  - `IMcpSyncService` 维持既有 3 个方法；数据同步与 trust 方法继续拒绝；
  - `IZCodeAgentService` 拒绝 `setWorkspaceMcpTrust`（不能经 Agent 通道绕过设置页方法收窄）。
- 拒绝错误保持 `kind: "feature_disabled"`，文案与现有远程同步拒绝一致。
- `desktop-continuous` 不套用方法白名单，保持完整服务面与既有 attachment 包装。

## B3 远端 workspace 重绑（先准备，后提交）

- `bindWorkspaceContext` 在任何不可逆副作用之前完成 preflight：
  1. 解析候选 `workspaceIdentity` / `workspaceKey`（不写 session）；
  2. `prepareWorkspaceIdentity` 在候选 context 上验证目标目录与身份（受本次 bind 的 `AbortSignal`）；
  3. WSL：等待候选 workspaceKey 既有 `releaseInFlight`（同样受 signal）；
  4. 每次 await 后校验本次 bind 仍是最新 attempt、session 仍在线且未取消。
- 提交是同步的：一次性写 `workspacePath/workspaceIdentity/legacyWorkspaceIdentity/workspacePurpose`、
  `generation += 1`、`workspaceKey/workspaceGeneration`、`workspaceReadyState = "ready"`；
  仅提交成功后才 `requestWorkspaceRelease(previousOwnership)`。
- 失败/取消：session 快照（path/identity/purpose/generation/workspaceKey/workspaceGeneration/
  workspaceReadyState）与旧 `entry.workspaceRuntimeByKey` 均不变，不释放旧 runtime，不登记候选身份。
- 并发/迟到 bind：`session.bindAttempt` 是内部 attempt token（不发布到 snapshot）；只有最新 attempt
  可提交，旧 attempt 在下一个 await 边界失败，不能切回旧目标。
- Host：`detachStaleRemoteSessionAttachments` 只在 `workspaceReady` 成功、且 ACK 前检查通过后执行；
  失败/取消路径不 detach。`RemoteWorkspaceContextBound` 仍是唯一成功信号。
- 不新增 identity registry；不通过超时/回滚覆盖更新的 generation。

## W1 文件 CAS 原子性

- `updateJsonObjectFile` 的「读取 → 调用方比较/修改 → 原子替换」整体包进
  `withAtomicFileLock(filePath, …)`；底层 `atomicWritePrivateTextFile` 自身不再取同一路径锁，
  避免嵌套死锁。
- 所有 CAS 写入方（MCP/技能/命令/插件/用户配置同步）共享这一命名空间；进程内 FIFO 与跨进程目录锁
  仍由 `withFileLock` 负责。
- 已知限制文档指向本 spec；不再引用不存在的 `docs/remote/data-sync.md`。

## W2 命令同步祖先软链

- `createOnly` 写入前检查 `commandsRoot("zcode")` 本身及其到目标父目录的每一级：
  命中软链即 `failed`，不创建目录、不写目标文件。
- 检查容忍尚不存在的子目录（ENOENT 视为“尚未创建”，继续检查上层），不吞真实 IO 错误。
- 最终组件仍由 `rename` 替换，不跟随目标软链。

## W3 `workspace/mcp/trust` 请求边界

- `setWorkspaceMcpTrust` 只接受本 Agent 的目标工作区：
  - `resolve(params.workspace.workspacePath) === resolve(context.deps.cwd ?? process.cwd())`；
  - `params.workspace.workspaceKey === workspaceIdentity?.trim() || workspacePath`；
  - 不满足时返回 `{ accepted: false, reasonCode: "workspace_mcp_trust_unavailable" }`，不写信任文件。
- 「本机表面」由 Host attachment 方法面执行：手机/Web 不能经 `McpSync` 或 `ZCodeAgent` 授予信任；
  桌面本地调用保持原语义。
- 仍不校验声明内容之外的 UI 展示；错误码区分仅保留既有两种。

## W5 个性化指令读取上限

- `getUserInstructions` 最多读取 `USER_INSTRUCTIONS_MAX_BYTES`（100 KiB）：
  文件更大时返回截断内容并标记 `truncated: true`；UTF-8 截断不保留半个字符。
- UI 读取到 `truncated` 时显示可见提示并禁用保存（复用现有超限文案），不得把截断草稿当完整基线。
- `saveUserInstructions` 在现有文件已超过上限时拒绝覆盖（`USER_INSTRUCTIONS_TOO_LARGE_ERROR_CODE`），
  防止“截断读取 → 保存”静默丢内容；正常范围内保存仍走原子私有写与写队列。

## 验收场景（临时 HOME/XDG/workspace/DB，loopback 或纯内存端口）

- B1：同时存在 `.zcodium/config.json` 与 `.agents/mcp.json` 时，fallback 服务器进入 `inspect`；
  未授权时 guard 不调用底层 `connectServer`；显式 user/builtin 来源仍准入；未知来源名字拒绝。
- B2：mobile 与 web-client attachment 调用 `getUserInstructions/saveUserInstructions/setWorkspaceMcpTrust`
  均得到 `feature_disabled`；合法 `get/update` 与 McpSync 三方法仍可用；desktop 不受影响。
- B3：abort 后 registry 快照与旧 runtime 不变；旧 attempt 不能覆盖新 attempt；WSL release 在提交前等待；
  Host 只在成功 ACK 路径 detach。
- W1：两个并发 `updateJsonObjectFile` 各自改不同字段，最终两个字段都在（无“检查后覆盖”）。
- W2：`~/.zcodium/commands` 为软链时 `createOnly` 失败，外部目录无写入。
- W3：与 `deps.cwd` 不一致的 workspace 请求被拒绝且不落盘。
- W5：超大文件读取有界且 `truncated` 可见；保存超限基线被拒绝，原文件不被截断覆盖。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 如实记录；不修改根 lock/package/baseline。
