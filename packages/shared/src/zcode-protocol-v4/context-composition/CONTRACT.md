# context-composition

让 App 外的消费方（第一个是扩展进程）读到「当前模型请求里各部分占多少」：类别、条目名和大小，不给正文。
完整规格见 `.agents/specs/upstream-3.18-context-projection.md`。

本目录只放线格式：细类别 id、条目上限与名字截断、细类别 → 圆环 7 个粗类别的投影、查询 / 通知 schema。

不变量：

- 一份分解：圆环的 `contextUsageBreakdown` 与查询结果来自同一次分类（CLI `core/src/runtime/context-composition/`），
  粗类别只由 `contextCompositionUsageSource` 投影得到；圆环的 7 值枚举不扩展。
- 只给名字和大小：条目名最长 200 字符，每类最多 50 条，0 值类别不返回。
- 修订号的唯一 owner 是 CLI 协议层 tracker；同一会话同一轮事件循环内的多次变更合并成一条通知，不用定时器。
- 预演没有副作用：不落库、不写历史、不发请求、不让草稿变成持久会话。
- existing-only：查询不为会话冷启动 CLI 或恢复会话；旧 CLI 的 method-not-found 由调用方当作 `null`。
- 演进：线格式是 strict；新增字段或类别会让旧 App 解析失败，必须另起方法或能力位。

模块注册（`architecture-policy.yaml` 的 managed 模块与 publicEntrypoints）由 integration owner 追加；
本片不修改 policy。
