# 上游 3.18.2 远端同步（R1：D1–D5）

## 范围与来源

- 官方来源：`.cache/upstream-3.18.2@fec97590`，对账区间 `3c5b2276..fec97590`。
- 只读 Rust 参考：`.cache/upstream-rust-reference`（不作为产品上游）。
- 本片覆盖 3.18 同步清单 D1–D5：远端设备生命周期（stop/restart/tasks/cancel update/降级）、
  远端目录准备（截止/单飞/取消后禁止登记）、Host↔Main bind ACK 与兜底次序、Server transport 命令面、
  Server CLI `stop --wait` / 整树 `restart`。
- 明确不恢复：归因遥测、request-auth/highspeed 分叉、off-peak、CUA 休眠帧、支付/账号强绑定。

## 单一所有者与事件顺序

```text
Renderer/UI 意图
  → ISourceServerManagementService（Host 编排：目录/状态/日志）
    → SourceServerManagementRuntime（Host 进程内）
      → windowRemoteConnectionRegistry（唯一连接 owner / lifecycle flight）
      → transportAdapter.exec/probe/installOrUpdate（远端命令唯一出口）
  → Server CLI（stop --wait / restart：唯一停止等待实现 shutdownWait）

目录打开（bind）
  → Main bind flight（同 session 同 contextKey 单飞）
    → Host BindRemoteWorkspaceContext（AbortController + 30s 截止）
      → registry.bindWorkspaceContext(signal)
        → prepareRemoteWorkspaceIdentity：readdir 单飞 + 截止 abort 本次 admission
  → Host RemoteWorkspaceContextBound ACK / BindFailed
    → Main attachRendererPort（只有 ACK 后才换代）
```

- 连接/生命周期状态唯一 owner 仍是 `windowRemoteConnectionRegistry`；不新增第二个 connection manager。
- Main 只做 request/session 与端口转发，不保存任务队列、快照或第二份 flight 状态。
- 远端命令只经 `SourceServerTransportAdapter`；Server CLI 不回调 Desktop 状态。
- `workspaceIdentity` 为身份键；`workspacePath` 只用于 IO/展示。取消后不得登记本次 bind 身份。

## D4 远端目录准备

- `prepareRemoteWorkspaceIdentity(fileService, input, bind?, {timeoutMs})`：
  - 默认截止 `REMOTE_WORKSPACE_PREPARATION_TIMEOUT_MS = 30_000`；超时以
    `remote-workspace-directory-unresponsive`（`retryable: true`）拒绝，并 abort 本次 admission，
    使迟到的目录读取不能继续登记身份。
  - 目录读取按 `fileService` 实例 × 路径单飞；返回即删，不缓存结果。截止只结束 Desktop 等待，
    不取消远端物理调用；单飞防止重试占满 Core libuv 线程池。
  - `ENOENT/ENOTDIR/EACCES/EPERM/ELOOP` → `remote-workspace-directory-unavailable`（不可重试）；
    网络/协议错误保持原语义。
  - 读取成功后若 signal 已 abort（取消或截止）必须拒绝，不调用 bind。
- `fileService.readdir`：同一路径已有读取超过截止阈值仍未返回时复用同一 Promise，返回即删。
- Registry `prepareWorkspaceIdentity` 钩子只在 `handle + sourceServerId + workspacePath +
workspaceIdentity` 齐全时调用；失败不得留下 ready session。

## D5 Host↔Main bind

- `CancelRemoteWorkspaceBind`：只取消本次 request，不 dispose 共享 logical session。
- Host 对每个 requestId 恰好 settle 一次：`RemoteWorkspaceContextBound` 或
  `RemoteWorkspaceContextBindFailed`（带 `reasonCode`/`retryable`）。
- Main 兜底 `REMOTE_WORKSPACE_PREPARATION_TIMEOUT_MS + 10_000`，必须晚于 Host 截止；超时先发
  `CancelRemoteWorkspaceBind`，再以 `remote-bind-canceled` 拒绝。
- Main 同 session 单飞：同 contextKey 的重复 bind 共享同一 flight；不同 contextKey 拒绝。
- ACK 成功后才更新 descriptor 并 `attachRendererPort`；失败不得换代 attachment。
- 保留 #91 首连/握手：连接 descriptor 的 Source 身份仍只来自鉴权握手。

## D1–D3 生命周期

- 服务方法：`cancelSourceUpdate(profileId)`、`stopSource(sourceServerId)`、
  `restartSource(sourceServerId)`、`getSourceRunningTasks(sourceServerId)`；
  只对桌面 Renderer 暴露。
- Flight 在 `windowRemoteConnectionRegistry` 内按 Source 互斥（update/stop/restart）；
  更新只在本机阶段可取消，进入远端写入阶段后不可取消。
- `stop`：先按显式断开收口（删除恢复意图/释放 owner），再执行远端 `stop --wait --json`；
  只有 `stopped|uninstalled` 才算成功；成功和失败设备都保持未连接。
- `restart`：登记 flight 并投影为连接中；执行 `restart --json`，只有 `ready` 后才失效旧在线
  连接并走现有 connect；失败 typed 失败。期间旧连接 close 视为预期断线，不当作普通掉线上报。
- `getSourceRunningTasks`：只读 `running-tasks --json`；输出无法解析/null/命令失败返回
  `{available:false}`，不能当“没有任务”；空数组才是没有任务。凭据不可静默取得抛
  `credentials-required`。
- `updateSource` 接受 `allowDowngrade` 并透传 `--allow-downgrade`；状态快照可带
  `updateCancelable`/`downgradedFrom`。
- 版本门禁 `SOURCE_SERVER_LIFECYCLE_CONTROL_MIN_VERSION = "3.17.0"`；旧 Agent 缺方法不得视为成功。
- 错误码：`source-server-stop-failed`、`source-server-control-unresponsive`、
  `source-server-update-in-progress`、`source-server-downgrade-unconfirmed`。

## Server CLI / transport

- `stop --wait` 输出最终 stopped/uninstalled 状态；`stop` 无 `--wait` 保持 ack 语义。
- `shutdownWait` 是唯一停止等待实现：基线 updatedAt → 锁缺失/stale 视为已停止 → 发 stop →
  等锁释放且出现新 stopped 快照；`stop-failed` 终态立即失败；超时 `SERVER_STOP_WAIT_TIMEOUT_MS`。
- `restart` 由 CLI 协调整棵进程树：统一停止等待后按 `serve --daemon` 启动并等 ready。
- transport `restart` 与 `serve --daemon` 一样保持 detached fallback；`update` 支持
  `--allow-downgrade`。上游的 `--prepare-credentials` 属于本仓明确移除的 `credential-security`
  面，本轮不恢复，也不把该 flag 接到远端命令。

## 验收

- 真实内存/loopback 测试，临时 HOME/XDG/data-root，不读真实用户数据、不连真实远端。
- 覆盖：截止取消后不能登记、stale generation、目录单飞、bind ACK/取消、lifecycle 互斥与
  stop/restart 命令结果、`running-tasks` 不可信清单、CLI `stop --wait`/`restart`。
- 不修改其他 writer 文件、根 package/lock/baseline/policy/catalog。
