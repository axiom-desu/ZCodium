# R1 / R3：Server CLI 真实产物与 starting 复用

父规格：remote-first-connect-usability.md、upstream-3.16-source-server.md。本片仅负责 packages/zcode-server-cli；不改 prepare/bundle、Host resolver、根产品版本或兼容门禁。

## R1 制品边界

- tsup 的 CLI/Core 两入口保留 `node:` builtin（尤其 node:sqlite），yazl/yauzl 保持外部 CJS 包，不能把其 require(fs) 打进 ESM。
- 产品版本从根 package.json 经既有 scripts/rolling-app-version.mjs 同源派生并注入 **ZCODE_VERSION**，根基线保持 3.16.2（实际为与 Desktop 相同的滚动版本串）；CLI version、Core ready 和 HTTP info 必须一致，不依赖运行时环境冒充版本。
- external 的生产依赖及传递闭包继续由既有 staging 产物扫描 + Node 解析规则拥有；需要的包显式声明，不能依赖机器额外安装的包。
- 回归 fresh build 后直接执行 dist/server-cli.js --version --json，并 fork dist/server-core.js：真实 IPC ready、loopback HTTP server-info、token、shutdown。隔离 staging 后实际用 external yazl→yauzl 写入/读取 zip，验证传递闭包。不得只验证 config 文本或用 tsx 跑源码替代。

## R3 readiness 所有者与顺序

```text
serve --daemon → canonical root → control status（Supervisor 唯一 lifecycle owner）
  ├─ ready + valid host/port → 成功
  ├─ starting → 原有有界 readiness 等待 → control status → ready + ingress → 成功
  │                                        └→ failed/terminal/timeout/abort → 失败
  └─ fallback→service 迁移 → 保留 busy guard、stop barrier 和原 service 注册路径
```

- 已存在 starting 不能输出成功/port:null，不另起 Supervisor、不重复注册、不改 lock 或伪造状态。
- 复用既有 readiness 循环与 control 请求，轮询是读取 owner 状态，不增加 sleep 兜底；默认 10 秒预算不增长。
- 等待现存 Supervisor 只读 canonical root 的实时 control 状态；崩溃/停止终态立即失败，不回退旧 persisted ready。status.pid 是 Core pid（不是 Supervisor owner），starting→ready 允许 null→pid 或 Core generation 推进；stale Core 事件继续由 Supervisor 原有 generation barrier 处理。
- 取消仅释放本调用等待/control socket，不停止共享 daemon；timeout 不改 owner 状态。程序化 runtime options 可传取消信号/短预算用于调用与测试，CLI 不新增参数。
- fresh startup 同样要求合法 ingress，保留 updatedAt/serviceRegistered barrier，失败状态立即报告。
- 不涉及任务、workspace identity、Host lease、continuous/replayable 语义或第二个业务 owner。

## 验收

- fresh bundle CLI 与源码入口都连接真实临时 control socket 验证 barrier；源码覆盖 starting→ready（barrier 前不得完成）、starting→crash-loop-stopped、timeout、abort、ready 缺 ingress、Core pid/generation 正常推进；只发 status，零 spawn/注册。
- 全部测试 HOME/XDG/data/root 隔离，HTTP 仅 loopback；不连接远端、不调用 OS service、不启动 Agent/模型请求。
- fresh build CLI/Core 回归先红后绿；目标测试、根 typecheck/lint、architecture --changed 与目标格式检查真实执行，已有失败单列。
