# 上游 3.18.2：Project Memory Semantic Recall 与 Dream handler

固定官方源 `zai-org/ZCode@fec97590`。本片只搬 Project Memory 的两条链路：
semantic-recall 检索分支与 Dream consolidation handler。来源：
`core/src/memory/{recall,dream,project-memory-retrieval-branch}.ts`、
`core/src/runtime/helpers/project-memory-{agent,recall,dream}.ts`、
`docs/design/v2/memory/README.md` §5/§7。

## 事实更正：Dream 不是产品自动功能

上游代码与设计文档一致：**当前产品链路不自动触发 Dream**。成功 Main turn 只调度
Extraction；没有 `/dream` 命令、没有 idle 扫描、没有协议字段、没有 Settings 开关。
本仓同样不新增自动触发点，只移植可 await 的 handler、24h + 10min gate、lock 与前缀，
并在台账中登记为「未自动启用」。任何「顺手加 idle 扫描/定时器/新命令」的实现都视为偏差。

## 状态所有者

```text
Main turn ──┬─ prefetch（AbortController，独立于模型请求，trackResidencyBlockingWork）
            │        └─ manifest → selector → read 正文
            └─ 完整真实 tool-result batch 之后 consume 一次
                     └─ readFileState + relevant_memory attachment（MCS）

session-local RecallState（内存）：manifest / selectorMessages / recalledPaths / 字符计数
  owner = AgentRuntime；compact、resume 重置；Dream 触达路径使其失效
Dream：pendingMemoryUpdate（每 runtime 一份，consume 一次即清）
Dream transcript gate 只读现有 model-io 目录；无第二套 transcript DB
```

- 单一宿主：仍是既有 `AgentRuntime` / `CommandInbox`。不新增 App、runtime、accepted 队列、
  manifest service、持久 cache 或 filesystem observer。
- 检索分支由 Core 唯一常量 `PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED` 决定
  （与上游一致，默认 `false` → `default-index`）；不新增配置/协议/测试 setter。
- 两条分支互斥：`default-index` 读 `MEMORY.md` 与 pointer；`semantic-recall` 不读 index，
  selector 与 `relevant_memory` 只能出现在该分支。

## Recall 时序与限制

```text
turn 开始（user 输入已落历史）→ startProjectMemoryRecallPrefetch（不 await）
  gate：分支=semantic-recall / 无在飞 prefetch / memoryRoot+fileSystem / 当前同一 model
        且 supportsJsonSchemaOutput / 会话字符数 < 61_440 / 最新非 meta user query 含空白
        / manifest 未全部 Recall

完整真实 tool-result batch → 先 drain queued input/runtime command
                          → selector settled ? consume 一次 : 本批不等待

consume：manifest 顺序 + 重复保留 → 路径存在 → read-state 快照过滤 → 前 5 → 读正文
        → readFileState（offset=undefined；截断时 limit=保留行数；isPartialView=false）
        → relevant_memory attachment（一次，固定 prefix 只出现一次）
```

- selector 必须走当前 turn 同一 model（`auxiliaryModelOptions` 档位），不切 provider、
  不做关键词 fallback、不重试；error/abort/非 text/无效 JSON/schema 不匹配一律空选择，
  迟到结果在 abort 后丢弃。
- 正文：保留 frontmatter；去 BOM、CRLF→LF；200 整行或 4096 UTF-8 bytes（byte 优先）；
  stale > 1 天追加冻结 warning。截断后追加冻结 suffix。
- 会话字符上限按注入正文（含 suffix）计数：达到 61,440 后不再启动；当前批次整体越过不二次截断。
- prefetch 与被过滤候选不写 read-state；只有最终注入项写。
- manifest：递归小写 `.md`，排除 `MEMORY.md`，不跟随目录 symlink，前 30 行解析 frontmatter，
  mtime 降序，最多 200；非空才 sticky。
- 取消（turn abort/cleanup）、compact、resume 清空 prefetch 与 RecallState。
  Dream 修改文件后丢弃未消费 prefetch，并清对应 read-state / recalled path / manifest。
- workspace 隔离沿用 `workspaceIdentity?.trim() || normalizedWorkspacePath`
  （既有 `resolveProjectMemoryRoot`）；remote workspace 与 symlink 越界保守拒绝。

## Dream handler

```text
runProjectMemoryDream（可 await，未挂任何自动触发点）
  gate1 enabled-root（与 Extraction 同一 helper）/ 非 remote workspace
  gate2 modelIoDir + sessionStore + fileSystemPort 在场
  gate3 距上次 lock mtime < 24h → skip；距上次 scan < 10min → skip
  gate4 本 workspace 至少 5 个 Main-equivalent session（排除当前），
        且 transcript `model-io-<id>.jsonl` mtime > 上次 consolidation
  lock：mtime < 1h 且 PID 存活 → skip；否则写当前 PID + read-back 认领
  run：最多 50 轮 Memory Agent（既有 loop / 既有受限 executor / 既有 tool catalog）
       执行前记录 Write/Edit/rm(.md) 目标路径（不以执行成功为条件）
  success：保留新 lock mtime；paths 非空 → pendingMemoryUpdate + Recall 路径失效
  error/abort：首次 lock 删除；旧 lock 恢复空内容与原 mtime
```

- `memory_update` 只由 Dream 产生；下一次附件收集 consume 一次并清空，即使承载它的请求失败
  也不重注入。foreground/Extraction 不产生该 attachment。
- session 归属按 workspace identity（有 identity 时）或规范化目录；不使用 SessionStore
  `updated` 冒替 transcript mtime。
- 本仓当前没有 model-io transcript writer，handler 因此仍不可达真实会话；这是
  「未自动启用」的加强状态，不以假目录/第二套 transcript 伪装接线。

## 负向验收

1. `default-index` 分支：不扫描、不发 selector、不注入 `relevant_memory`，`MEMORY.md` 仍在。
2. selector 失败/abort/非法 JSON/额外字段 → 空选择，不读正文、不写 read-state。
3. 已 Read 或已 Recall 路径被过滤；同批次重复保留；第 6 项不回填。
4. 未 settled 的 prefetch 不等待、不消费；同一 prefetch 不重复消费；turn 取消后不注入。
5. compact/resume 后 RecallState 与 prefetch 归零（下一次合格 query 重新扫描）。
6. Dream：remote workspace 直接返回；24h/10min gate；新鲜存活 lock 不动手；
   lock 认领失败不动手；失败恢复旧 lock；transcript mtime 不比 SessionStore 时间。
7. 真实 loopback 模型 + 真实 SQLite runtime 回归：请求体含 `relevant_memory` 一次、
   已知路径不回填、关闭分支时不出现。

## 未搬/留账

- 每 attempt 前的 provider runtime headers 刷新端口本仓不存在，selector 复用现有模型调用上下文。
- Dream 的 `modelIoDir` 依赖暂未由 bootstrap 注入（无 writer，见上）。
