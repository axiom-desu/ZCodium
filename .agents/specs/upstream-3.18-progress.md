# 3.18.2 搬迁检查点：实际交付与剩余

本文件是 `.agents/specs/upstream-3.18-sync.md` 的持久台账，不将子agent口头完成、版本号或
新增文件数当作完成证据。官方固定源 `zai-org/ZCode@fec97590`；起点 `27d0f29f`。
Rust参考为 `MBearo/ZCode-rs@a7a980de`，不是产品上游。**本检查点不是完整功能对齐或发布候选。**

## 已接通并定向验证的生产链

| 域           | 本仓落点与实际行为                                                                                               | 关键验收入口                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| TS上下文     | instruction公告、15M预算、prompt快照与两种fork复制、环境增量、Plan五阶段提醒                                     | CLI core/bootstrap 包级测试，`upstream-318-*`            |
| 模型工具     | provider原生工具多轮持久化/冷恢复、usage锚点、session-features请求头                                             | provider-tool-rounds + loopback SSE/SQLite               |
| CLI工具      | shell块只交模型/Bash、LocalToolSearch、全局Hook失败策略、ask搜索预算、Cron自暂停                                 | contracts/core/bootstrap 包级测试                        |
| MCP          | workspace准入与摘要审核、混合配置fail-closed、lease/entry/caller取消                                             | workspace-mcp-trust、mcp-pool-cancel                     |
| 会话控制     | standalone八工具、App十二意图与Host/Main/Root导航、稳定消息fork、executionId停止fence                            | session-control + appControl/appFork + desktop导航测试   |
| 插件发现     | SearchPlugins/SuggestPluginInstall、mentionItems服务与UI消费者、真实loaded状态                                   | pluginMentionItemsClient、插件工具/面板测试              |
| 配置同步     | 六分类CAS、远端独有项保护、设备本地状态、Main provisioning lane、单一弹窗                                        | dataSync + provider lane + `test:data-sync-ui`           |
| 项目数据     | restore/measure/delete，sessionData四方法、0025反复活迁移、v2有界SQLite备份                                      | projectData/sessionData/SQLite contract测试              |
| 远端         | directory preflight→commit、取消/单飞/ACK、原registry生命周期、stop/restart/tasks/降级UI                         | desktop Host + source-server/CLI目标测试                 |
| Worktree     | Git/项目预占/admission、创建/fork/释放/移除闸门、跨进程锁、未知ACK保留目录                                       | managedWorktreeTasks/CrossHost + `test:managed-worktree` |
| 远端项目     | 现有entry表持久化intent/CAS、只读catalog、本机入口列表/移除/缓存恢复                                             | remoteProjectEntries + `test:remote-projects-ui`         |
| 浏览器       | human inspect→预览→确认写回批准项目；fd/CAS保护；page/element PNG与PDF真实Main端口                               | browserDesign\* + Electron loopback测试                  |
| 文件应用     | 现有platform getter按路径枚举Linux/macOS/Windows关联应用                                                         | file-open-apps fixtures，Linux实际端口                   |
| 扩展最小闭环 | private SDK、默认拒绝网关、逐插件进程/凭据、consent、撤销、状态槽位                                              | `test:extension-host` + gateway/service测试              |
| 设置/UI      | 个性化指令、设置搜索、文件另存/外部打开、图片标注、会话查找/批注、插件后台/嵌套frame                             | `test:upstream-318-ui`/settings/browser守卫              |
| Locale/scope | 五语言与英语fallback、设置scope实际Hook页消费者、单DataSync根owner                                               | `test:locale-switcher`、settingsScope测试                |
| Rust对应部分 | 上下文/快照/原生工具轮次/生命周期/sessionData/context composition/session features/LocalToolSearch/CronPauseSelf | Rust workspace + schema/oracle/driver检查                |
| 构建         | Electron44.7.0/builder26.17.0/updater6.8.10；所有Desktop类型配置与CLI依赖、SDK进入根检查                         | `pnpm typecheck`、Web/Desktop no-runtime build           |

### 主代理审查后修正，而非绕过测试

- 未审核workspace MCP混合配置绕过 → 全量发现与缺省拒绝；手机方法面明确收窄。
  主代理最终又验证了同名用户条目反例：名字匹配不代表执行载荷可信，实际配置摘要也必须匹配（红→绿）。
- 全局用户指令写入不发布给手机/Web；100KiB截断与保存保护。
- 同源CAS加同命名空间锁；命令目录祖先软链拒绝。
- Remote bind先准备、后一次性commit、再detach旧attachment，取消不破坏旧scope。
- Worktree创建异常不能等价“未创建”：预占与CLI双证明之外保留目录；跨进程锁与实际终端cwd保护。
  主代理又补出“receipt/投影都消失”的红→绿反例：缺席不是未接纳证明，必须明确released才可继续清理。
- 浏览器写回批准根由既有project/task owner派生，不信renderer自报root；`O_NOFOLLOW`/inode/nlink复验。
- 扩展凭据不放env，按插件身份绑定并经stdin一次性引导；激活失败不报ready；零权限也要代码激活consent。
  第三方Node进程**没有OS沙箱**，授权UI与合同均明确此边界，不承诺防恶意同UID系统进程。
- App中断交原runtime原子比较executionId；fork边界按真实V4快照映射，未知ACK不伪成功。
- quotes贯穿canonical intent、幂等、编辑和冷恢复；Rust暂不支持则显式拒绝，不静默丢字段。
- 主代理复跑抓到App factory经browser barrel引入`node:crypto`：根入口改为type-only，
  新增 `test:services-browser-entry` 红→绿并进CI，**没有external掉Node来假通过**。
- TS冷恢复合法usage空assistant锚点回归：修生产hydrator，不改node-cold oracle来迁就错误。
- contracts公开面新增三项按真实API更新枚举fixture，保留完整相等断言，没有删除测试或放宽基线。

## 首个检查点f6515b7f的历史实测（Node24.14.0 / pnpm10.33.2）

- `pnpm typecheck`：覆盖Desktop main/preload/renderer/host/scheduler/app-navigation、CLI核心依赖、SDK与session-control。
- `pnpm lint`：0 warnings / 0 errors；`verify:pre-push`的lint/format/architecture零新增。
  `test:services-safety` 现已实际执行并接入CI，94项Node + 186项Vitest；不再仅依赖内存worktree UI smoke。
- `gate:knip`：regressed 0（原baseline未改，当前相对baseline减少81项）；raw knip存量不冒充清零。
- CLI六包：**595 passed**（contracts37/core226/adapters69/bootstrap208/node-repl43/session-control12）。
- Services：node:test **94 passed**；当前源Vitest **39 files / 186 passed**。
- Desktop Host/原生应用/截图/App导航/扩展/Provisioning：**27 files / 216 passed**。
- UI/集成：15条根测试入口均通过，包括手机Web、设置、DataSync、worktree、locale、扩展、browser-design、
  app-shell-full-view、workbench-split、file-manager、browser公共入口。不是15个用例，含多个单测/Chromium守卫。
- Rust：**989 passed / 0 failed / 1 ignored**；fmt、clippy `-D warnings`、16-crate边界全过。
  protocol-schema、contract-assets、domain-fixtures、state-fixtures、driver63项均通过。
- browser guest原生专项由子agent执行真实Electron44+loopback：PNG/element/PDF **17/17**；
  主代理复核真实binary为44.7.0。macOS/Windows枚举仅fixture，不冒充跨平台实机。
- 初次Services Vitest误匹配`.cache`参考源码且隔离HOME找不到浏览器binary；纠正为仅当前源、
  排除`.cache/**`/`**/dist/**`，显式指向已安装工具binary缓存后原185项全部通过，追加receipt负向回归后186项通过。未改断言隐藏失败。
- licenses基础标识/新鲜度通过；**仍有16项材料待发布前严格核验**，不能宣称完整合规验收。
- 0025迁移SQL按上游原字节/已锁checksum镜像，design vendored内容也保留原字节；两者自带的
  尾随空白不为git diff检查擅改。其余自有源码的staged whitespace检查通过，未放宽任何lint/架构棘轮。

## f6515b7f之后的已验证增量

- **Memory源码与生命周期**：搬完semantic selector/content/read-state与prefetch/consume/reset；
  Dream锁/时序/失败恢复及await handler已搬。默认semantic recall关闭、Dream不自动触发，和官方一致，
  不新增静默后台调度或宣称已自动启用。真实loopback模型与SQLite测试已跑。
- **插件敏感配置**：既有manifest `sensitive`→单一file-config resolver→private原子写/跨进程锁；
  legacy迁移、scope/层序、普通↔敏感转型、0600及软硬链处理、reset/uninstall、UI保留/清除已接。
  实际D1导入/导出过滤legacy明文和private file。self user-options只有受信任port，尚未接RPC/SDK。
- **话题资源**：原认证bot ingress的accepted快照→CLI tool→Host授权下载→受管文件已接，
  目前Feishu/Lark。Desktop和server HTTP的replayable共享严格方法白名单，内部入站/下载不对Web开放。
- **输入预测**：仅显式窄Web的原ConversationComposer/Lexical，cap精确true才请求；不新建composer/runtime，
  不进CommandInbox/不续期，不持久化hint；显式采纳保留mention、精确空白与焦点。
  edit/pending submit/stop/dispose取消到真实模型HTTP；late结果和缓存均有generation保护。
  已撤回误接旧mobile入口的改动，旧mobile/relay仍暂停。
- **扩展会话facade**：12个既有App意图、sessions.read/write声明及consent、五语言许可文案；
  Gateway注入plugin/generation身份，跨插件幂等/撤销/迟到ACK负向验证。
  真实Main child/SDK/loopback/临时SQLite→原AppControlService已验证，v1原三能力不改语义。
- **Rust App模式12工具**：可信Host preferences授予、root/subagent门、真实registry与HostRequest；
  真实native app-server子进程↔Node protocol client↔原AppControlService跑List/Read/Rename，
  caller/旧连接/取消/unknown ACK有回归。不是standalone CLI八工具或Rust插件发现已完成。
- **CI缺口**：查询确认f6515b7f远端Checks/oracle/remote/Windows失败；补root session-control冷构建前置，
  从实际无dist状态重建oracle依赖及remote server均通过。修旧loopback ACK夹具、Electron44 ClipboardItem
  测试夹具与Windows专属symlink测试编译；没有加timeout掩盖失败。
  新native纵向并入services-safety，入口先构建当前Rust binary，CI先准备Rust；新consent/prediction smoke进CI。
- **审核收口**：五个旧未用type继续不进公开barrel，真实跨文件结构保留唯一权威与完整shape/消费断言；
  声明导出的TS4058用明确`ReturnType`收口，不恢复无消费者export或放宽strict。
  两个topic模块policy根已覆盖真实reader/handler/磁盘归档，不只注册spec/空目录。

本轮最终Node24.14.0 / pnpm10.33.2验证：typecheck、lint **0/0**、format、architecture、knip零新增；
CLI六包 **688**（37/272/81/242/43/13）；services **116 Node + 207 Vitest**；
Rust **1011 passed / 0 failed / 1 ignored**及fmt/clippy/boundaries/四项schema-fixture门禁通过。
真实Composer预测、原手机layout/focus、扩展consent/child、敏感表单、真实native↔Node纵向均通过。
首次宽/桌面fixture用过早的initScript误造入口，现从实际HTML设置profile，并加无runtime error断言；
submit使用有效queue快照及真实生产submit回调，pending时立即撤销预测。未经验证的真机/平台结论仍不扩张。

## 剩余，不能宣称“代码全部搬完”

1. **扩展完整上游面**：当前为v1三个只读能力、状态槽位及已授权12会话facade；
   上游完整视图、多槽位、能力集合/SDK兼容尚未逐项搬完。不能把private同名SDK当官方完整SDK。
2. **浏览器设计完整面**：多选/CSS变量/方案分页/undo-redo/live reload等尚未齐；site-permission
   UI等上游增量仍需逐项对账。现有inspect/确认写回/page-element-PNG/PDF不代表全域完成。
3. **Worktree体验**：父目录未提交改动的迁移、assistant fork菜单入口、mobile pendingInteractions等未齐。
   非Linux或无法证明终端cwd时保守拒删；Linux脱离PTY进程树的孤儿后台进程不可观察。
4. **CLI/资源尾项**：self-plugin user-options RPC/SDK消费者尚未接；topic资源其他provider/远端workspace
   归档仍需逐项对账。Memory备用分支保持官方默认关闭，不将其误报为自动功能或未搬源码。
5. **Rust preview parity**：standalone CLI八工具/插件发现、每ask WebSearch预算、workspace MCP真实授予、
   `forkAssistant.targetCwd`/releaseUnderDirectory、conversationQuotes仍未支持；能力false/严格拒绝，
   不假成功或用metadata宣称已注册。工作区Hook `onError`影响审核摘要，执行仍默认allow（TS同样）。
   元数据资产不注册工具，已有回归证明未注册名字不进模型候选/执行。
6. **真实进程/平台验收**：完整Electron交互、真实手机键盘/公网TLS、真实SSH/WSL/Docker全生命周期、
   Rust app-server→NodeStore活链路与对应制品、Windows/macOS制品及严格许可材料尚未最终验证。
7. **明确排除/暂停**：上游账号绑定ASR ticket、归因遥测、off-peak/highspeed/request-auth执行分叉、
   CUA休眠帧/内部云依赖不恢复；relay后续仍暂停，原stash未纳入本检查点。

## 提交与发布边界

本检查点只冻结已经实际接线、测试并修过审查缺陷的一批代码，后续继续按上述剩余项推进。
产品版本暂保留3.17.2，避免用3.18.2暗示完整功能对齐；版本/发布另提交。
不自动替换现有安装，不出新安装包，不合并主分支。PR应保持draft，并明确这是partial semantic port。
