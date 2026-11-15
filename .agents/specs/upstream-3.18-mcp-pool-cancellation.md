# 上游 3.18.2 MCP 连接池 lease 取消（Q2）

## 范围与来源

- 上游：`.cache/upstream-3.18.2/apps/zcode-cli/packages/adapters/src/mcp/pool.ts`
  （`leaseShutdown` / `wait` / `PoolEntry.controller` / 立即释放），固定 `fec97590`（3.18.2）。
- 本仓落点：`apps/zcode-cli/packages/adapters/src/mcp/pool.ts` 与
  `apps/zcode-cli/packages/adapters/src/mcp/pool-entry.ts`（现有 Q1 拆分，保持单一 pool owner）。
- 生产调用方：`bootstrap/src/zcode-protocol-entrypoint.ts` 的 `mcpPortFactory`
  （每 session 一个 lease）与进程级 `protocol-settings` lease；session 结束时
  `bootstrap/src/app/session-facade.ts` 经 `mcpPort.close()` 关闭该 lease。
- 不在本片：`waitForAppConnection`（本仓 adapter 未实现该可选方法）、资源订阅登记表、
  OAuth 授权流程本身、Rust CLI 对应实现。

## 唯一所有者与事件顺序

```text
pool（进程级唯一连接 owner）
  └─ entry（一个 transport；controller=entry 级取消）
       ├─ connecting / revalidate：只受 entry.controller 约束
       └─ refs（leaseId 集合）

lease（一个 session 或 protocol-settings）
  ├─ leaseShutdown（lease 级取消，close 时 abort）
  └─ 请求：callTool/readResource/list*/subscribe/unsubscribe
        signal = any(caller.signal, leaseShutdown.signal, entry.controller.signal)

lease.close()
  → leaseShutdown.abort("MCP session lease closed")
  → 在途 wait(connecting/revalidate) 与在途请求立即以 abort reason 结算
  → release(serverName, immediate=true)
  → session 隔离：entry.refs 归零即 closeEntry（不再等 idle grace）
  → workspace 隔离：entry 仍被其它 lease 持有，只减 ref，不关连接
```

- 不新增第二个 pool、不做 timeout 替代 abort、不重试掩盖取消。
- entry 的 `connecting` 只继承 `entry.controller.signal`：连接归 pool，不能被第一个租用它
  的 session 的 caller signal 中止，否则会连带打断共享该连接的其它 lease。
- caller signal 只取消“本次等待”（`wait`）与本次请求，不关闭 entry；调用方取消后
  `entry.connecting` 继续完成，后续 lease 可直接复用。
- 关闭 entry（idle grace 到期、pool.close()、session 独占 lease 关闭）先
  `entry.controller.abort()`，再 `adapter.close()`：在途 connect/重连与请求先结算，
  不允许 adapter.close 与它们抢同一 transport。
- `closeEntry` 以 `entry.closing` 记忆化：idle timer 与 pool.close 并发只执行一次
  `adapter.close()` 与一次 `unregisterConnection`。
- 重连（revalidate）沿用同一 entry 身份；重连期间 lease/pool 关闭会中止重连，
  迟到的 `connecting` 不能写回已移除的 entry（`entries.get(key) === entry` 校验）。
- 提示请求（server → client `elicitation/create`）属于当前工具调用的子等待：
  工具调用期间登记调用 signal，elicitation 端口以该 signal 调
  `requestElicitation(..., { signal })`，lease 关闭同样取消该提问等待。

## 失败语义

- lease 关闭后新请求 `throw` "MCP session lease is closed"（不排队、不兜底重连）。
- 在途请求以 `leaseShutdown` 的 abort reason（Error: MCP session lease closed）拒绝；
  caller 取消以 caller 的 reason 拒绝，二者不互相覆盖。
- `lease.close()` 幂等：重复调用返回同一 promise，不重复释放 refs。
- 一个 lease 的取消/关闭不影响同 entry 上其它 lease 的在途请求。

## 验收

`apps/zcode-cli/packages/adapters/test/mcp-pool-cancel.test.ts`（node:test，临时 HOME/XDG，无真实配置/网络）：

- lease close 取消在途 `callTool`（adapter 观测到 signal abort）与在途 connect 等待；
- lease close 取消在途 `readResource` / `listResources` 等待；
- caller signal 取消本次请求但不关闭共享 entry，另一 lease 继续可用；
- 共享（workspace isolation）entry 上关闭 lease A 不取消 lease B 的在途请求；
- 重连期间关闭 lease：重连等待被取消，entry 关闭后无残留 entry、`adapter.close()` 只执行一次；
- elicitation 端口收到当前工具调用 signal，lease close 后该 signal abort（adapter handler 接线）。

## 不变边界

- 连接创建/复用仍由 `pool.ts` 单独决定；`pool-entry.ts` 只提供 entry 生命周期。
- `processTracker` 的 source 归一（workspace/user → custom）与 S1 工作区 MCP 信任
  默认拒绝（`guardPort`）不改：本片只透传/合并信号，不放宽任何准入。
