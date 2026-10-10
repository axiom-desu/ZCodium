# Rust CLI state/core/core-api 边界回归

## 行为与所有权

- SessionRuntime / Core Engine 是活动执行、队列、目标与 revision 的唯一恢复/运行时 owner；只有显式激活或 startup recovery 经 `load_session` 调用 Node `load+recover`。普通冷会话读取通过独立 `read_session` 纯读 port 产生临时投影；缺省实现明确不可用，不回退调用会恢复的 load。
- `stop` 携带 `expectedForegroundExecutionId` 时，执行前将其与当前活动 execution 的 `Option` 比较。idle、缺失 active 或 mismatch 一律 `noop` / `guard.stopTargetChanged`，且不取消工具/children/auth，不改变 goal、queue、autodrain、revision 或 tool-cancel 状态。matching 才执行原 stop；未携带 expected 的旧调用继续停止全部。
- session-scoped ACK 查询先验证持久化 session row 的 workspace identity，再查询或结算 ACK ledger。workspace 不匹配返回 `None` 且不得写 foreign ledger。全局 `createSession(None)` ACK 维持原有全局契约。冷 ACK settle admitted 的写入是 Node 契约明确允许的 recovery query，不将所有查询宣称为纯读；本次仅加隔离校验。
- mixed-runtime filelock 策略不在本任务决策范围。

## 存储接口与事件顺序

```text
普通冷 session/read → Core 临时投影 → SessionStore::read_session → NodeStore read-only transaction/snapshot → decode（无 SQL write；保留原仅内存 Session::recover 临时投影，不 commit）
显式 session 激活 / startup → Core owner → SessionStore::load_session → Node load + compact/input recovery → 后续读取可见恢复投影
ACK query → Core query → Node Store load session row → workspace_key 校验 → matching 才 lookup/settle ledger → ACK
stop(commandId) → Core CommandInbox 按 exact key 查 receipt → 命中则原 receipt replay（accepted 改 duplicate）→ 未命中才裁决新请求
stop(expected) 未命中 receipt → 已 resident active/session 比较；冷且非 resident 时只读 read_session 验证 workspace 与 revision → mismatch/idle noop；合法 matching active → 取消及目标/队列状态更新 → receipt
stop(no expected) 未命中 receipt → 原有无条件停止语义
```

唯一持久化恢复 owner 是 `load_session` 的 Node load+recover 路径；读投影不得触发恢复。Node 只读投影使用一致的只读事务视图并复用现有低层 resume/decode，禁止重复实现恢复逻辑。

## 验收场景

1. 带 expected 的 idle 和 stale stop 均返回 `guard.stopTargetChanged`，queue、goal、autodrain、revision、tool cancellation 全不变；matching active 确认执行原 stop；无 expected 保持原语义。必须经真实 `Engine::dispatch_command` 执行并在 Engine/真实取消 token、fake IO port 读取前后状态；旧 `stop_command_tests` 中四项只调用 `stop_target_changed` / `stop_admission` 的 helper tests，以及 `let after = before` 伪状态比较，不构成状态不变或副作用证明，须由真实 dispatch 覆盖替换。Exact-key accepted receipt 必须写入真实 Engine ACK cache（或 fake store lookup），active run 消失后重放原命令应返回 duplicate，不能仅测 admission helper。
2. 至少一次以临时禁用生产 guard 或将其移动到 cached ACK 检查之后的变异验证，确认相应真实 dispatch regression test 失败；恢复生产代码后同一测试通过。
3. 真实临时 NodeStore DB 在存在 admitted 输入及 interrupted compact 时，`read_session` 与 Core cold `session/read` 前后账本、compact 记录不变；激活 `load_session` 恢复一次后读取相同最终投影。FakeStore 的只读 port 显式纯读实现。
4. 同路径的两个 remote identity 与两个 local workspace 对 foreign ACK 查询均返回 None、不写 foreign ledger；own lookup 正常；全局 create-session ACK 原契约不变。
5. Rust 目标文件遵守 400 行与 `unsafe_code = deny`；不改 Cargo、平台、protocol/schema/generator、历史 SQL/fixtures。
