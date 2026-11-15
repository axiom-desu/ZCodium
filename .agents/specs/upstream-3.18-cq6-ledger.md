# CQ6 留账：与 3.18.2 的逐源比较结论

来源：`.cache/upstream-3.18.2` @ `fec97590`（只读参考树）。本文件只登记比较结论与判定依据，
不描述未实现能力的“已完成”。

## 1. project-memory dream / recall

| 上游落点                                           | 本仓现状                                                             | 判定                  |
| -------------------------------------------------- | -------------------------------------------------------------------- | --------------------- |
| `core/src/memory/dream.ts`                         | 已搬锁、24h/10min时序、失败恢复及可等待handler                       | 已搬，**不自动触发**  |
| `project-memory-retrieval-branch.ts`               | 已搬；默认`false`与官方一致                                          | 已对齐默认行为        |
| `recall/{content,selector}.ts`                     | 同一模型JSON能力门禁、manifest选择、受限读取、read-state一致性       | 已搬并定向验证        |
| `runtime/helpers/project-memory-{dream,recall}.ts` | 请求前prefetch、tool-result批次后consume、compact/resume/cleanup重置 | 已接原runtime生命周期 |

唯一owner仍是原runtime memory状态。真实loopback模型/临时SQLite回归见
`.agents/specs/upstream-3.18-project-memory-recall-dream.md`。官方并未开启semantic recall或自动Dream，
本仓也不擅自开启；不能把已搬的备用分支描述成用户默认已启用的后台功能。

## 2. plugin secrets 配置 adapter

| 上游落点                                                                                                              | 本仓现状                                                            | 判定             |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------- |
| `adapters/src/config/plugin-secrets.adapter.ts`（`plugin-secrets.json`、user/workspace 两层、私有文件权限、损坏备份） | 已移植到 `adapters/src/config/plugin-secrets.adapter.ts`            | **已实现（S4）** |
| bootstrap侧“敏感选项的私有值分流与读取叠加”                                                                           | `bootstrap/src/plugin-secrets.ts` 接既有 file-config 层序与写入路径 | **已实现（S4）** |

更正：敏感键声明的权威已存在于`contracts/src/plugins/index.ts`的`sensitive`字段，
不能以“无敏感键owner”为由排除。现已沿原`file-config`配置层序与写入路径接私有文件adapter，
保持单一resolver，无独立配置缓存；公开UI/导出脱敏，runtime/受信任本插件读取保留实际值。
私有文件是敏感字段的唯一持久owner，不与公开config持久化同一字段；迁移应先私有写入再移除旧明文。

实现与验收见 `.agents/specs/upstream-3.18-plugin-secrets.md`：`sensitive` 键由原 `configure/reset/uninstall`
分流到私有文件，读取走单一 `applyPluginSecrets` 叠加（无独立缓存），UI/导出脱敏。仅本插件user视图的受信任读port已有身份校验，但**未注册RPC/接SDK生产消费者**，
不能把它算作已可用的插件设置API；实际runtime配置插值已走同一resolver。

## 3. 本地 ReadTopicResource

| 上游落点                                                     | 本仓现状                                                | 判定                  |
| ------------------------------------------------------------ | ------------------------------------------------------- | --------------------- |
| `core/src/tool/topic-resource/{contract,reader}.ts`及handler | 已注册真实tool，仅接受当前会话已接纳input/message/index | 已接线                |
| Host已接纳快照/资源下载port                                  | 原bot ingress→admission→archive→CLI反向RPC→受管文件     | Feishu/Lark纵向已验证 |

Desktop attachment与server HTTP replayable共用Bots方法白名单，Host-only资源下载与入站回调默认拒绝；
下载前后复核input、identity、bot授权与generation。见`.agents/specs/upstream-3.18-t5-topic-resource.md`。
其他provider与远端workspace归档仍未齐，不把单provider纵向写成所有Bot资源能力完成。

## 4. Desktop / date / Git 段

| 项         | 本仓                                                                              | 判定                                                                               |
| ---------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Desktop 段 | system 内 `sections/desktop.ts`（`presentationSurface === "zcode_desktop"` 才发） | 已有 owner；本片只把“离开 Desktop”写进环境公告（见 environment-announcement spec） |
| date       | 独立 `current-date.ts` 段                                                         | 不改为上游排版（纯字节差异，无行为收益）                                           |
| Git        | `gitStatus:` 前缀                                                                 | 保留；`# gitStatus` 标题是排版差异，会改 prompt 快照字节                           |

## 5. Rust

- Rust 无 `conversation_quotes` 任何落点：材料渲染、持久化、投影都没有 owner。
- 因此 Rust 侧必须显式不支持（能力不声明 + 解析显式拒绝），不能“接受命令但丢掉批注”。
- 生成物 `crates/protocol/schema/v4-command.json` 由生成脚本收口：P8 已补齐 `forkAssistant.targetCwd`
  的 allowlist 并重生成 schema/oracle；Rust 对 quotes 的拒绝来自 `refinements`，不依赖生成物缺口。
