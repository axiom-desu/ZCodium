# Rust CLI M2：stop / idle 状态验收

## 目的与范围

收敛 M2 中 stop 命令对运行中、已停止和 idle 前台执行的判定，使 Rust Core 与当前 TS V4 `session-flow.ts` / Core foreground execution 一致。范围只涉及 Rust `crates/core` 与 `crates/domain` 的 run/stop/state 文件；不改变 SessionRuntime/Engine 状态所有权、不新增 owner 或兜底分支。

## 状态所有者与事件顺序

`Engine.active` 是 Rust 当前前台 run 的运行态事实所有者，run 的取消状态由该 `Active.cancel` token 表示；TS 对应 `activeForegroundExecution` 及其 `AbortController.signal.aborted`。命令经 Core admission 裁决，stop 仅对命中的未取消执行取消，并按既有路径提交状态与 ACK：

```text
stop command → Engine command admission → expected execution guard
  → active run cancellation → existing stop state transition → durable commit/ACK
```

不改状态所有权、提交路径或 ACK 结构。exact command ACK replay 优先于当前执行状态检查；重放不得二次提交或取消。

## 行为规则

- 带 `expectedForegroundExecutionId` 的 stop 只对同 ID 且尚未取消的 Active 执行产生 stop 副作用。
- 目标不匹配、没有 Active，或 Active 已取消，均按 TS 的 `idle` / `mismatch` stale-stop 处理：返回 `noop` 与 `guard.stopTargetChanged`，不取消工具/子任务、不变更 queue/goal/revision、不写 commit。
- 当前 token 匹配且未取消时，stop 被接受；取消并完成现有状态转换，durable commit 后返回并缓存 accepted ACK。
- 不带 expected ID 的旧客户端 stop 保持既有无条件兼容语义。
- 旧 run 的 stop 不得触达后来启动的 run；exact-key ACK replay 保持现有优先级。

## 验收场景

1. 无 Active 的 idle session 携带 expected ID：no-op，无 commit/状态副作用。
2. 已取消但仍暂留在 Active 表的 run 携带同一 ID：视作 idle，不重复执行 stop 副作用。
3. 未取消的当前 run 携带匹配 ID：成功取消、状态变更经 commit 后返回；重复 command replay 不重复副作用。
4. Active 为新 run 时，携带旧 run ID：no-op，不能取消新 run，也不能提交状态。
5. 无 expected ID 的 legacy stop 保持既有行为。
6. command commit barrier 及旧 run 防护不因本修复改变；所有 noop guard 均不 commit。

## 当前证据与修复边界

TS `stopActiveForegroundExecution` 在 controller 已 aborted 时返回 `idle`；V4 handler 对携带 expected ID 的 `idle` 或 `mismatch` 均返回 stale-target no-op。Rust 在取消 token 已 cancelled 但 Finished 尚未移除 `Engine.active` 的短暂窗口中，只比较 run ID，因此会把重复/迟到 stop 当作当前执行并再次取消、暂停状态与提交。这是已确认差异；将 stop admission 的 active 视图按已取消 token 归为 idle 即可修正，不扩展通用状态机。
