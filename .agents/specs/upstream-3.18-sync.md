# 上游 3.18.2 全量语义搬迁

## 固定来源与范围

用户要求优先完成上游代码同步，可并行由子agent实现，主代理审核；手机/relay后续工作暂停。

- 唯一产品上游：`https://github.com/zai-org/ZCode`，固定 `fec97590`（3.18.2）。
- 完整待对账范围：3.16.2 `3c5b2276` → 3.18.2，包含3.17未完成能力，不只3.17.2→3.18.2。
- 当前分支基点 `27d0f29f`（含#91远端/RPC与#92现有Web手机适配），不回滚已完成工作。
- Rust源码参考：`MBearo/ZCode-rs@a7a980de32da5da539d361e937702610b801e03d`，Apache-2.0，
  只借鉴适用实现，不作为产品上游，不替换本仓crate布局/协议，不复制其V5内核或40-crate架构。
- 参考树位于 `.cache/upstream-3.18.2` / `.cache/upstream-rust-reference`，仅只读，不属于交付。
- 子agent若明确因余额/额度不足失败，用用户指定 `openai-codex/gpt-6-luna` 重跑该任务；
  测试、编译或设计失败不归因于余额，不用换模型掩盖。

不是整树merge，不跟上游删除测试；不把文件存在/版本号视为完成。每项须接通真实调用路径，
不允许空实现、常量成功、仅新增未使用helper或挂名能力宣称移植完成。

## 单一所有者与兼容边界

```text
UI/CLI意图 → 原Host路由/lease → 原runtime CommandInbox → 状态/持久化 → 派生投影
remote connect/stop/restart → 现有windowRemoteConnectionRegistry → 原backend/daemon
配置同步请求 → 目标类别服务（唯一写入者）→ 原子CAS写入 → 本机设备状态投影
```

- 不新增第二runtime、accepted队列、远端manager、配置缓存权威；Main/relay不存业务队列。
- `workspaceIdentity?.trim() || workspacePath`保持隔离；路径用于IO，远端透传remoteSessionId。
- Desktop continuous 与 Web/mobile replayable 交付语义都保留，默认拒绝未审查频道。
- 新协议字段/方法有schema校验、可读失败、旧Agent方法缺失不能被视为成功。
- 生命周期异步flight归现有owner；stop→restart串行，取消后禁止登记，旧generation不能写新实例。
- 项目移除、恢复、彻底删除分开；不删除用户工作区源码，引用保护/活跃会话/Host隔离先验检查。
- 配置同步不得删除远端独有条目，overwrite必须重算expectedTargetHash，路径越界/符号链接拒绝。
- 新本机同步状态不得暴露给远端或手机；Main provisioning lane仅Main为权威。
- 不恢复明确移除的归因遥测、off-peak、request-auth/highspeed执行分叉、CUA休眠帧、支付/账号强绑定
  或内部服务依赖。新增本地能力不能仅因原上游有云消费者就自动排除；须检查可用本地边界。
- 保留Google等本仓公开provider能力，不用上游目录覆盖删除；目录更新与行为代码分开审查。
- Rust适用能力要追踪双侧差距；引用源码保留许可/NOTICE与显著修改说明，不直接复制参考NOTICE业务声明。

## 并行实现批次与落点

各writer先建子spec、读取AGENTS/architecture skill与模块context；共享组装点由主代理整合。
所有worker不得提交、改baseline、重置其他worker文件或修改参考树。
继续批次允许各worker精确注册自己新模块的policy/public入口并维护同名module.ts；
这是架构拓扑声明，不是放宽baseline或添加忽略。先写contract/示例/规格，再注册policy，
再实现行为；不得以“未注册模块”或“原消费者不存在”结束仅spec任务。
root锁文件、统一生成资产、最终格式化与整合提交仍由主代理所有；新增依赖需求先在各包manifest声明并报告。
每个任务须交付至少一条完整生产调用链和负向回归，未实现部分明确留账，禁止用空实现消除类型错误。

| 组  | 实现域                                                                  | 主要落点/owner                                         |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| C1  | TS指令公告、total_tokens预算、prompt字节冻结、上下文投影                | CLI core context/runtime/history；原runtime            |
| C2  | Rust对应上下文与provider-native wire修复                                | Rust core/model/domain；原session与model owner         |
| C3  | Hook onError、命令shell交给Bash、LocalToolSearch、WebSearch预算、自暂停 | CLI contracts/tool/executor；原admission               |
| C4  | 会话生命周期、MCP信任、插件启动降级                                     | bootstrap lifecycle/trust/startup；原session residency |
| R1  | 远端目录截止/单飞/取消、设备stop/restart/tasks/降级                     | 原registry、directory、backend、daemon                 |
| U1  | 个性化指令、设置搜索、文件另存/外部打开                                 | 原settings/file/platform hooks                         |
| U2  | 图片编辑、会话查找/渲染、plugin后台/nested frames                       | 原conversation/plugin-ui owner                         |
| P1  | 内置design插件与node-repl执行闭包/进度守卫                              | 原builtin资产与broker，保持跨平台                      |
| D1  | 配置分类同步、设备同步状态、provider provisioning状态                   | 原配置服务/Main lane                                   |
| D2  | 项目恢复/测容/彻底删除、V4 session-data、SQLite有界备份                 | 原project/storage/session owner                        |
| C5  | 会话控制/插件发现/provider工具回放/session features等剩余项             | 原CLI runtime及Rust对应实现                            |
| G1  | 依赖/打包/生成资产/许可/版本                                            | pin不降级；版本独立提交                                |

每组只在实际完成后标记实现；未实现/未接线/仅TS/未验证分别记录，不能用“代码已搬完”笼统覆盖。

## f6515b7f 后续搬迁批次

沿用同一分支与Draft #93，不创建第二条实现线。先补：

- project-memory semantic recall的真实请求前预取/注入/重置；Dream按上游代码明确**不自动触发**，
  只移植可等待handler与隔离/锁规则，不能擅自新增后台自动扫描或宣称其生产已启用。
- plugin secrets的敏感键权威已存在于PluginUserConfigOption.sensitive；由原file-config owner
  分流私有值，公开UI/导出脱敏，runtime/仅本插件的受信任读取使用同一resolver，不造配置缓存。
- ReadTopicResource必须绑定Host已接纳话题快照与会话/输入身份，不允许模型传任意URL/路径下载；
  沿现有bot ingress接纳链建立资源归档，不恢复已删除的外部bot登录或官方云依赖。
- input prediction只使用当前配置模型与原runtime的只读sidecar，草稿仍归composer；取消/换代/编辑/提交
  立即失效，不进入CommandInbox、业务续期或watchdog回收，不隐式另选provider。
- Rust native优先接现有Host App-control/插件发现反向RPC，身份来自可信init/run上下文，
  无Host/未声明能力/子agent均隐藏；不得把元数据键或空port算成工具实现。
- worktree脏状态迁移与fork菜单、mobile pendingInteractions派生；browser设计draft undo/redo、
  多选/CSS变量/原有site-permission owner的真实UI；扩展优先复用已存在的App-control facade扩会话能力，
  保持逐插件身份/授权/撤销/旧代际保护，不冒充已兼容完整上游SDK。

各片仍需自己的spec与负向验收；新public入口须注册policy。共享装配/锁文件/生成资产由主代理整合。

## 验收

- 新行为先添加临时HOME/XDG/data/workspace/DB、loopback测试，不读真实配置/日志/凭据、不连真实远端。
- 每片执行实际runner；CLI现有node:test与上游Vitest不混用。UI行为需真实组件浏览器守卫。
- 最终typecheck、lint 0/0、format、architecture零新增；不放宽棘轮，knip当前11条继承问题独立说明。
- Rust fmt/check/test/clippy -D warnings；必要TS/Rust跨协议测试；Desktop/Web与既有手机回归。
- 新依赖须锁文件/许可/SEA/原生闭包审查；Node24.14.0/pnpm10.33.2 pin不以绕验证方式修改。
- 明确代码移植、自动化覆盖、真实手机/公网/跨平台制品等尚未验证边界；本轮不自动安装制品。

## 实现台账

本轮多组并行实现与对抗审查已整合，实际接线/主代理修正/验证结果/剩余边界统一登记在
[`upstream-3.18-progress.md`](upstream-3.18-progress.md)。该文件是持久台账，优先于早期`/tmp`快照
与子agent阶段报告。**当前仍为partial port，不是完整3.18.2对齐**；扩展完整面、浏览器完整设计、
CLI memory/resource/prediction与Rust preview若干能力等继续开放。此批冻结为draft检查点，
不自动发布/安装、不合并main，产品版本尚不以目标版本暗示完成。

### 全量复核后的追加搬迁边界

- 不能把“没有原消费者”当排除。继续搬扩展Host/slots、受管worktree、浏览器设计/元素截图/
  guest捕获、会话选中评论、文件应用枚举、新语言、App控制与插件mention消费者、CLI memory/
  quotes/secret与MCP lease取消、Rust工具侧对应行为。
- 扩展SDK源码上游 `packages/plugin-api` 实际存在；内部workspace可保留上游兼容名称并设private，
  不要求本仓拥有npm发布域，不因命名空间错误排除整个扩展功能。扩展能力授权默认拒绝，
  window-scoped进程生命周期不取代既有LocalHost业务owner。
- 受管worktree仅操作明确受管路径与所有权元数据，检查引用/运行态/dirty；不删除用户任意仓库。W1 决策：本机用户显式添加的 remote project entry 是持久化 INTENT，归既有 `remote_project_entries` 表；连接身份/状态仍归既有 registry，catalog 仅作只读组合，不增设 connection manager。mobile pendingInteractions 只扩展既有 mobile-directory projection。
- App控制只路由到已有窗口/项目/CLI owner并复用权限，不产生第二accepted队列/导航权威。
- 新语言不移除中英；本仓新增键缺译时回退英语，语言选择/日期格式用同一locale owner。
- 上游voice-input实际调用 `/api/v1/asr/tickets` 且依赖 `getToken()`（缺失即401），属于账号强绑定
  内部ASR而非离线本地能力；不恢复该endpoint或伪造本地可用语音按钮。若新增自托管ASR需独立接口规格，
  本次记录为明确的内部服务排除项。此前只读盘点将其笼统归“本地可用”不准确。
- Hook `onError` 是每Hook失败策略不是第八个Hook事件；Rust应补策略读取/执行，不添加伪OnError事件。
- 并行初轮审查确认的MCP准入fail-open、手机全局指令写入、CAS锁、重绑先commit后prepare已由S1修复；
  仍须以整合后的负向回归验收，不以单组测试通过代替全局审查。
- Q2（MCP lease 取消）规格与落点见 `upstream-3.18-mcp-pool-cancellation.md`；只接在既有 pool/lease 上，
  不新增第二 pool，不改 S1 准入与 source 归一。
