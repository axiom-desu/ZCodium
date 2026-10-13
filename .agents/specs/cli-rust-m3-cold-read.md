# Rust CLI M3：只读冷加载验收

## 范围与基线

本规格只覆盖 `apps/zcode-cli-rust/crates/state` 的 Node SQLite session cold-read、resume 与恢复边界；不改历史 SQL/校验和、不迁移真实库、不改变默认存储路径。DB 测试一律用临时目录中的临时库。既有总 runtime spec 与 checkpoint review status 描述更大的里程碑/状态，本文件只补本次验收约束，不替代它们。

## 状态所有者与调用语义

- 已提交的会话事实由 Node-compatible SQLite DB 持有；SQLite state adapter 负责查询/提交。SessionRuntime 持有恢复后内存态，并通过 NodeStore 的 commit/journal 路径提交变更。
- `SessionStore.read_session` 是冷读/投影查询：用 request-scoped read-only connection 与一致性快照恢复模型可见 Session，不取得恢复写权；不得修复数据库或结算 pending input。
- `SessionStore.load_session` 是显式 runtime resume/admission 边界，不是只读查询。对照 TS `resumeFromStore`，由其负责 interrupted compaction recovery 和将进程重启遗留的 admitted input 结算为 discarded/session_resumed；状态变化通过既有 storage mutation 路径提交。恢复完成后再次读到的是持久状态。
- DB open/startup migration 是单独的启动写路径，由 `NodeStore::open` / migration runner 唯一负责；不把它隐含在 read_session 中。不得在此验收迁移或改变默认路径。

事件顺序：

```text
NodeStore open (既有 migration owner)
  → read_session: barrier → read-only connection → deferred snapshot → decode/projection → commit snapshot
  → load_session: worker queue → resume recovery writes (compact / admitted input) → reload projection → runtime Session
  → later SessionRuntime journal commit: accepted business writes
```

## 不变量与失败语义

1. 对已经打开且迁移完成的临时 DB，执行 `read_session` 不改变任何 schema/table 行内容；返回的 Session 投影可正常读取，重复冷读结果一致。
2. 对包含 interrupted compaction 与 admitted input 的 DB，`read_session` 后恢复标记、ledger 全行及其他用户表内容均与读前一致；运行态投影不伪造恢复已完成。
3. 随后调用 `load_session` 才允许既有 TS 对齐的恢复副作用：interrupted compaction 收口，admitted input 留痕为 discarded/session_resumed。后续冷读必须能读取恢复后可用状态。不得把只读失败转化成写入修复。
4. 错误/缺失/foreign workspace 冷读不产生写副作用。恢复路径失败由调用方观察到，不静默吞错或在冷读中兜底。
5. 本次只触及 Rust state adapter/spec/test；若实现证明需要 core、protocol、model、schema 或历史 SQL 改动，停止并向主 agent 报告，不扩展范围。

## 与 TS 存储语义对照

TS `apps/zcode-cli/packages/core/src/runtime/methods/resume.ts` 的 `resumeFromStore` 会恢复中断 compact timeline，并通过 `discardPersistedPendingSteerInputs` 明确结算重启后无法继续的队列；这是显式 resume 生命周期，不是 SQLite 查询副作用。Rust 的 `Worker::load` 对应这条恢复路径。Rust `read_session` 是单独的只读快照 API，应保持纯读。TS DB startup migration 属于 store open，不是 `getSession/messages` 冷读本身。

## 验收场景

- 在全新临时数据库初始化并写入会话、interrupted compaction、admitted input；记录所有非内部 SQLite 表的 schema 与逐行值，以及关键运行态字段。
- 冷读前后比较完整逻辑 DB 快照（不是仅比较被怀疑的两张表），验证会话可恢复且状态未变。
- 显式 runtime load 后验证只有恢复 owner 改变预期事实，再次冷读成功，且既有 TS oracle fixture/Node cold parity 测试继续通过。
- 执行 state crate 实际 Cargo 测试；不访问用户 home 下数据库，不触碰 migration SQL/校验和。
