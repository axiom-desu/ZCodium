# CQ6 留账：与 3.18.2 的逐源比较结论

来源：`.cache/upstream-3.18.2` @ `fec97590`（只读参考树）。本文件只登记比较结论与判定依据，
不描述未实现能力的“已完成”。

## 1. project-memory dream / recall

| 上游落点                                                                                         | 本仓现状                                                         | 判定       |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ---------- |
| `core/src/memory/dream.ts`（`.consolidate-lock`、24h 间隔、10min 扫描节流、锁超时）              | 0 命中                                                           | **未实现** |
| `core/src/memory/project-memory-retrieval-branch.ts`（`semantic-recall` 分支判定）               | 0 命中                                                           | **未实现** |
| `core/src/memory/recall/{content,selector}.ts`（辅助模型 JSON Schema 选内存）                    | 只有 `recall/{manifest,types}.ts`，仅供 `extraction.ts` 渲染清单 | **未实现** |
| `core/src/runtime/helpers/project-memory-{dream,recall}.ts`（请求前预取 / compact、resume 重置） | 0 命中                                                           | **未实现** |

依据：本仓的 memory owner 是 `runtime.memoryRoot` + `memory/extraction.ts` 抽取循环 + index 注入。
dream 需要一个“会话静默后由辅助模型合并 memory 文件”的后台调度 owner；recall 需要
（a）辅助模型选择器（严格 JSON Schema + 模型能力门禁 + 每轮一次预取生命周期）、（b）把选中的 memory
文件按 read-file-state 注入附件、（c）compact/resume 时重置。三者都要新增跨轮后台状态，
与 CQ6 的 quotes 主题无交集，需独立 spec + 真实 loopback 模型回归，不能在本片用 helper + 空调用糊过去。

## 2. plugin secrets 配置 adapter

| 上游落点                                                                                                              | 本仓现状                                 | 判定       |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------- |
| `adapters/src/config/plugin-secrets.adapter.ts`（`plugin-secrets.json`、user/workspace 两层、私有文件权限、损坏备份） | `pluginSecret*` 0 命中                   | **未实现** |
| bootstrap 侧“哪些插件选项敏感、读取时如何叠加”                                                                        | 插件配置走既有 config 分层，无敏感键清单 | **未实现** |

依据：本仓插件配置没有“敏感选项”清单 owner；直接照搬会得到第二个配置缓存，并把明文密钥写进新的
文件格式。正确做法是先定“敏感键声明属于插件 manifest 还是 Host 配置 owner”，再接入既有
`file-config` 写入路径（原子写 + 权限），本片不新建第二配置存储。

## 3. 本地 ReadTopicResource

| 上游落点                                                                                | 本仓现状                                                                                                       | 判定       |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------- |
| `core/src/tool/topic-resource/{contract,reader}.ts` + `handlers/read-topic-resource.ts` | 0 命中（无 tool、无 reader）                                                                                   | **未实现** |
| 依赖：会话已接纳话题快照 + topic history 文件 + Host 侧 bot 资源下载 port               | `packages/services/src/bots` 只有 astrbot/feishu 通道与投递，没有 topic history 归档，也没有 topicResourcePort | **未实现** |

依据：该工具只读“当前会话已接纳话题快照”里的资源，安全性完全来自 topic history 归档的接纳边界。
本仓没有这个归档 owner，先建工具会得到一条绕过接纳边界的下载通道，因此保持留账。

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
