# 3.16 后续切片：项目存储、分享与完整视图

父规格：[upstream sync](upstream-3.16-sync.md)。运行期首批 PR #89 的候选为 `202d9325`，尚待精确 CI。
本切片从该树继续；项目/分享来自 3.16.1 `0a1fc56d`，完整视图叠加 3.16.2 `3c5b2276` 的最终语义。
源码改动前读取当前服务契约、DESIGN.md、CONTEXT.md；不把 /tmp 规划草稿当权威。

## 1. 项目地基（S8-A）

目标：在现有 Host tasks-index 数据库和启动流程内实现上游项目组织事实，不新建第二数据库/进程/业务 owner。
本批先完成真实迁移、repository/公开服务 port 与组织查询；Controller/UI 连接是后续 S8-B，不能以空 CRUD 模块宣称已完成侧栏。

```text
startup composition → existing tasks-index connection + migration orchestration
  → historical ledger validation → compatible appended migrations → project organization tables

Host project command → public service contract → one repository transaction
  → durable project/root/task-group organization → existing Host projection (next slice)
UI draft/preferences ── commands only ────────────────────┘
```

- projects/project_roots/host descriptors/task-group admission 为 Host 组织态；CLI session、accepted queue、模型结果仍由原 owner 持有。
  Host 项目 id 不得替换 workspace identity、CLI input_history.project_id 文本 scope 或历史 task 主键。
- 同一个 tasks-index.sqlite；旧 tasks migration 0001–0003 的输入与 checksum 原样保持。
  ledger 表/列与上游双 0004 必须从实际源码核实；单迁移 owner 不等于随意合并历史账本。
  不重编号、不覆盖 checksum、不因为已有列而跳过其余缺列。新共享 runner 若采纳，需证明旧 checksum 算法/事务/备份恢复兼容。
- 迁移保留所有历史任务，包括 deleted 行与组织关系；可见查询维持已有删除过滤，不能把“保留已删数据”误解为重新展示它们。
- 项目初次导入只使用 composition 注入的旧已保存 workspace 事实与顺序；不从任意历史会话/任务组推断新项目。
  只传 path/identity/name/顺序和脱敏 target 描述，绝不带认证数据或易失 remoteSessionId。
- 唯一身份规则仍为 identity.trim() || path。远端同路径不合并；不能把无法证明 authority 的身份自动归为 local。
  只使用既有身份构造/解析工具，未能证明归属的旧行保持未分配且可读，不编造 host key 格式。
- 本地多 root 与远端单 root 的写事务边界按上游真实契约：创建、修改、移动、reserve/prepare 均验证；
  远端空/多 root/换 root 不得部分成功。组织变化不重写已存在会话的 cwd/身份或执行事实。
- task-group admission 的 creationId/来源校验与用户整理优先顺序落在原唯一仓储事务，不建立第二 group store。
- 新 managed 模块先提供 contract/module/example/CONTRACT.md 和 policy，实际层划分 domain/app/adapters；
  UI 只能 hooks→服务公开入口，禁止引用 Repo。共享 Node SQLite helper 用独立公开子路径，不把 Node IO 导进浏览器通用 shared 入口。
- 异步文件备份/恢复；日志只写迁移 id/阶段/错误分类，不输出行内容、认证或用户路径。

验收：空库、旧三迁移库、部分列库、旧账本冲突、失败回滚/备份恢复；旧行/删除计数/身份逐行保持；
初次 seed 幂等不重排；同路径不同远端隔离；多/单 root 正反例；task-group admission 幂等/迟到不覆盖用户整理。
Controller/Renderer 尚未消费前明确标为地基，不增加假消费或放宽 knip 来通过。

## 2. 完整视图（S11-A）

目标：按 3.16.2 的 side-pane-full-view 行为在现有布局中进入/退出对话/侧栏完整视图，保留本地 workbench 分屏。

```text
button / desktop shortcut → UI controller → existing per-owner side-pane memory
  → derived layout/surface/floating state → same mounted conversation instance
close pane / change owner / unsupported surface → explicit exit/recompute
```

- 完整视图是 UI 局部状态，不是服务端事实；复用既有 owner key（包含原先工作区/任务隔离），不新造所有者。
- 对话实例不移动到另一个 React 分支重新挂载，不克隆 composer；切换 surface/浮窗三形态不得丢草稿、滚动、上传。
- 普通模式与退出后的 conversation/side pane/terminal 宽度不变。面板关闭立即退出，不用延时或重挂载修布局。
  分屏禁用覆盖所有入口（菜单/快捷键/拖到边缘/drop），提交时重验当前派生状态，不能只隐藏一个入口。
- 浮窗吸附位置偏好沿上游七位置持久化；现有主题/语言/缩放、键盘 focus、窗口大小变化正确。
- 仅 Desktop 支持；Web/手机/远控不显示入口、不注册快捷键。本地保留的多 pane 分屏不拆除，
  若完整视图不能安全共存则多 pane 显式禁用入口，回到单 pane 后再允许，不静默改变分屏状态。
- 快捷键使用现有注册/平台服务；核对既有绑定冲突，不能覆盖原动作；服务访问通过 hooks，不直接 window.zcode。
- 按 DESIGN 复用 Button/Tooltip/tokens/i18n；所有 JSX 文件 .tsx。新模块登记真实 contract/依赖并遵守大小门禁，不复制上游 609 行大组件或新增豁免。

验收：进入/退出、两 surface、浮窗三形态/七吸附位/恢复、关闭/切任务/resize、单实例与草稿/滚动/上传保持，
多 pane 保留、Web/手机无入口；亮暗/双语/键盘；交互必须有使用实际生产组件的隔离浏览器 E2E，不能只测纯 model 或复制版 harness。

## 3. 分享内容（S11-B）

目标：采纳 3.16.1 workflow v2/tool-presentation/inline-image 与连接范围的真实增量，保留当前分享 service 与 selection 草稿 owner。
本仓没有官方账号/远端分享服务，因此**不引入 HTTP 发布**：发布仍是本地可移植归档（`.zcodium`），
HTTP 只出现在匿名公开页读取分享预览（base 显式注入，测试只走 loopback）。

```text
selection draft（store，唯一 owner） → pinned workspaceIdentity/remoteSessionId/sessionId + revision/logEpoch
  → ConversationShareService.preflight/publish（唯一 service owner，连接范围内读 rows/artifacts）
  → inline image materialize → workflow snapshot → public projection(content_blocks)
  → archive v2（manifest 严格校验）→ UI 下载 / 导入副本
  → Web 落地页：loopback 预览 API → decode rows/content_blocks → @zcode/ui 只读渲染器
```

### 3.1 契约与版本协商（`packages/shared/src/conversation-share*`）

| 载体                      | 当前写出                          | 读取端行为                                                                        |
| ------------------------- | --------------------------------- | --------------------------------------------------------------------------------- |
| 归档 manifest `version`   | 2（含 content_blocks）/ 1（无块） | 1 按旧形状严格读取；2 追加块校验；>2 报 `unsupported_version`（不是「文件损坏」） |
| workflow 内容块           | `version: 2`                      | `v1` 仍可读；`v1 + preview_text` 判定非法（文本预览是 v2 语义）                   |
| tool-presentation 内容块  | `version: 1`                      | 图片 `resource_id` 必须与 `resource_ids` 双向一致；未知版本不认领 fallback row    |
| 公开预览 `schema_version` | 1                                 | 更高版本 → `unsupported_schema_version`（提示升级）；rows 逐行降级并计数          |

- 内容块容器上限：blocks 200 / artifacts 32 / items 256 / jsonDepth 16 / jsonBytes 32768 / images 32。
- 块内 JSON 拒绝 `file:`、`data:`、`javascript:`、`zcode-artifact:` 前缀与 `__proto__`/`prototype`/`constructor` 键；
  工具 display 只取公开白名单（`outputPath`/`input`/`targetApp`/`media`/`ui`/`permissionStatus` 全部丢弃）。
- 归档块必须引用同一份公开投影里的 artifact/public id 与 fallback row（类型、productTurn 一致），
  悬空引用在 encode/decode 边界即 `invalid_archive`，不把坏卡片交给渲染端。
- 「不可用」只能显式表达：`unavailable: source_unavailable | unsupported | limit_exceeded`；
  未采集到 run 时不造空 run，回退 assistantText 摘要。

### 3.2 服务（`packages/services/src/conversation-share/*`）

- `ConversationShareService` 仍是唯一 owner：预检与发布共用 `inline → workflow → projection` 同一转换，
  `artifactSnapshot` 对内存字节（内嵌图片/工作流产物）走 `inlineBytesBySourceRef`，不新增文件读取通道。
- 内嵌图片（`node_repl_images` / cua `media`）转成正式 artifact row + bytes；非法 base64 / MIME 不在白名单时
  产生 `artifact_read_failed` / `artifact_type_not_allowed` 非阻断提示，绝不静默丢图。
- 服务端能力声明 `content_block_versions` / `access_modes`；缺失 `tool-presentation` 时预检给 `content_unavailable`。
- `turnResults[].rowBudget` 只带本 turn 行数与上限，UI 按当前选择重算合计（不缓存某一批 RPC 的合计）。
- 导入副本写入 `formatVersion: 2` + `content_blocks`；读取端对旧副本（v1）保持可读，行/块/version 任一认不出都计入软提示。

### 3.3 UI 与连接范围

- selection/preflight cache owner 不变：`conversationShareSelectionStore` + `conversationSharePreflightCache`。
  fingerprint 纳入 `toolCall.display`（内嵌图片会改变载荷），scope 纳入 workspaceIdentity/remoteSessionId/sessionId/revision/logEpoch。
- 迟到结果规则：preflight/publish 的异步回调先比对 scope ref 与 attempt `clientRequestId`；
  不匹配就丢弃（不覆盖新范围、不跳转旧会话、不清理新一轮的 publishing）。同一 attempt 的进度串行推进。
- 只读块渲染：`contentBlocks` 由 `ConversationShareReadonlyTimeline` 解码；workflow 块替代 fallback 摘要，
  tool-presentation 块补图片+display；只有实际呈现的块才认领 fallback row，未知/不可呈现块保留降级正文。
  unavailable 且无 run/artifacts 的 workflow 必须保留一次可读摘要，不得同时被 turnBlocks 与 fallbackBlocks 排除。
  渲染器不得直接读 Repo/网络；
  公开 artifact URL 的读取只发生在匿名落地页（`artifactUrls` 注入时），Desktop 导入副本不传 URL。
- 手机/远控入口不变（仍为 unsupported 文案）；本批不新增移动端入口。

### 3.4 匿名公开页（`packages/web/src/share`）

- 路由：`/share/<code>`（英文）与 `/cn/share/<code>`（中文）；code 只接受 URL-safe 字符集，解码后含分隔符即拒绝。
- `ConversationSharePreviewClient`：base 由 `VITE_ZCODE_BASE_URL` 或同源 `origin/api/v1` 显式给出，仓库不内置生产地址；
  请求只读 GET，显式 credentials:omit；正文读取按源合同的总字节上限有界，不使用无界 response.json。
  日志脱敏（不记录 code/JWT/正文/签名 URL）。
- artifact 文本/图片由公开页注入的 artifact reader 读取：GET 同样 credentials:omit、referrerPolicy:no-referrer，
  正文走 `packages/shared` 的纯 Response/ReadableStream 有界读取器，预算取归档合同的
  `CONVERSATION_ARCHIVE_LIMITS.artifactBytes`（不另设更小上限）；声明长度或流式累计超限都立即取消底层流。
  `data:` 只从已有字节本地解码，不发起网络；非 http(s)/data 协议一律拒绝。图片转成 object URL 时必须
  按 share 范围/URL 代次隔离：旧请求的迟到结果不得覆盖当前内容，卸载或换代只撤销自己那一代的 URL。
- 落地页复用 `@zcode/ui/conversation-share-readonly`（生产渲染器），错误态可重试；未知行给软提示、不整页失败。
  单件 artifact 读取失败只影响该卡片（超限显示自己的限额提示），不清空其他已渲染卡片。

验收（已执行）：旧 v1/新 v2/未来版本；真实 loopback 请求字节与 CORS；错误码/版本分类；
URI/prototype/MIME/限额/图片；悬空块引用；字段清洗（本地路径、base64、`original_path`）；
stale 指纹/换 workspace/session/revision/取消选择；真实浏览器 E2E（packages/web 入口 + loopback 分享 API，
含工作流卡、工具图片、未知行软提示、错误重试、无脚本执行、无生产端点请求）。

## 4. 仍需单独映射的面

- R3/SourceServer 不因新类缺失就默认排除；先映射到现有窗口连接注册表/Host attachment。
  “连接用户自建 server”不自动等于新增 Desktop Remote Host；只有确实改变 owner 的设计才需另行对齐。
  账号/OAuth/官方 relay 与本仓明确移除面仍排除，手机不另起 Agent。
- office-runtime：原始依赖/字体许可、完整分发闭包、用户主动导入副本的唯一写路径及沙箱限制先审查再实现。
  不把“锁图已有”视为许可通过，不增加泛化许可豁免；原严格许可材料积压不掩盖。

## 验证与交付

实现由子任务完成，父会话独立 review。根 typecheck/raw lint（0/0）、格式/三 gate、架构与目标包真实测试必须执行。
禁止新增 ignore（包括测试夹具）、放宽基线、假消费、删断言/加 timeout；只用临时 HOME/XDG/workspace/DB/browser profile 与 loopback。
实际由 HTML/Vite/浏览器脚本加载的 fixture 可以按真实入口登记给静态分析，必须用源码引用与执行证据证明，不能用新 ignore 遮蔽。
不读取 logs/ 或真实用户数据、不装/重打安装包、不替换 .395、不发 Release。
首批 PR #89 未通过精确 CI 前不宣称合并；本批尚未完成也不升级根版本到 3.16.2。
