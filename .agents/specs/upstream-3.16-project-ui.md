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
- 浮窗吸附位置偏好沿上游七位置持久化；现有主题/语言/缩放、键盘 focus、窗口大小变化正确。
- 仅 Desktop 支持；Web/手机/远控不显示入口、不注册快捷键。本地保留的多 pane 分屏不拆除，
  若完整视图不能安全共存则多 pane 显式禁用入口，回到单 pane 后再允许，不静默改变分屏状态。
- 快捷键使用现有注册/平台服务；核对既有绑定冲突，不能覆盖原动作；服务访问通过 hooks，不直接 window.zcode。
- 按 DESIGN 复用 Button/Tooltip/tokens/i18n；所有 JSX 文件 .tsx。新模块登记真实 contract/依赖并遵守大小门禁，不复制上游 609 行大组件或新增豁免。

验收：进入/退出、两 surface、浮窗三形态/七吸附位/恢复、关闭/切任务/resize、单实例与草稿/滚动/上传保持，
多 pane 保留、Web/手机无入口；亮暗/双语/键盘；交互必须有使用实际生产组件的隔离浏览器 E2E，不能只测纯 model 或复制版 harness。

## 3. 分享内容（S11-B）

目标：采纳 3.16.1 workflow v2/tool-presentation/inline-image 与连接范围的真实增量，保留当前分享 service 与 selection 草稿 owner。

```text
selection draft → pinned workspace/remote scope + content revision
  → service preflight/sanitize/limits → injected share HTTP endpoint
  → matching result only → existing share UI / Web viewer
```

- 不新建账号/官方服务依赖，测试只用 loopback，不向生产分享端发请求。
- 新共享契约保留旧版本读取/协商；不因新增 v2 而清空旧 v1 内容，未知版本明确降级/拒绝。
- 按上游限制检查 blocks/artifacts/items/JSON bytes/图片大小和 MIME；拒绝内部 URI、prototype 键、递归超限，
  不能把 artifact 本地路径、凭据或 workspace 私有元数据泄漏到分享 payload。
- 迟到 preflight/上传必须验证相同 workspaceIdentity、remoteSessionId、会话与选择 revision，不覆盖新范围或跳转旧会话。
- UI 复用现有 selection/preflight owner，不搬目录制造第二缓存/队列；手机不因本批新增不支持入口。
- UI 通过 hooks/服务公开入口，不直接 Repo/网络或平台具体实现。跨 managed 边界先更新 contract。

验收：旧 v1/新 v2/未知版本、真实 loopback 请求字节、字段清洗/限额/图片、异步换 workspace/选择/重连迟到、取消保稿、
Web renderer 安全呈现/无脚本注入、现有分享选区交互不回归；交互需隔离浏览器 E2E。

## 4. 仍需单独映射的面

- R3/SourceServer 不因新类缺失就默认排除；先映射到现有窗口连接注册表/Host attachment。
  “连接用户自建 server”不自动等于新增 Desktop Remote Host；只有确实改变 owner 的设计才需另行对齐。
  账号/OAuth/官方 relay 与本仓明确移除面仍排除，手机不另起 Agent。
- office-runtime：原始依赖/字体许可、完整分发闭包、用户主动导入副本的唯一写路径及沙箱限制先审查再实现。
  不把“锁图已有”视为许可通过，不增加泛化许可豁免；原严格许可材料积压不掩盖。

## 验证与交付

实现由子任务完成，父会话独立 review。根 typecheck/raw lint（0/0）、格式/三 gate、架构与目标包真实测试必须执行。
禁止忽略、放宽基线、假消费、删断言/加 timeout；只用临时 HOME/XDG/workspace/DB/browser profile 与 loopback。
不读取 logs/ 或真实用户数据、不装/重打安装包、不替换 .395、不发 Release。
首批 PR #89 未通过精确 CI 前不宣称合并；本批尚未完成也不升级根版本到 3.16.2。
