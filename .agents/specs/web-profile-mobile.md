# 现有 Web profile 手机适配（不新增入口或托管）

## 范围

按用户纠偏，暂停 relay v2 重写；其未提交工作存入
`wip/relay-v2-paused-for-mobile-web-profile` stash，当前独立分支只改现有 Web UI。
复用 `packages/web/index.html → main.tsx → Root → App → WorkspaceShellLayout`，
不增加 HTML 页面、静态托管服务、relay 协议或第二个 MobileApp。
不自动启动另一套 web profile runtime；服务连接、Host唯一owner和协议语义不变。

## 产品规则与所有者

- 显式 Web 入口标记 `data-zcode-entry=web` + `(max-width:767px)` 判定手机 Web；
  Electron 不带该标记，窄桌面窗口仍走原桌面布局。
- `WorkspaceShellLayout` 仍是布局组合唯一入口，`useAppPanels` 仍拥有面板开合。
  手机不复制任务/会话状态、不增加持久化偏好。手机进入时左栏默认关闭，展开时覆盖主区
  （抽屉+遮罩，不挤占会话宽度）；关闭/遮罩/Escape可返回，选任务/新建后收起。
- 抽屉使用已有 Dialog 基元承担焦点约束与可访问名称，不复制另一套sidebar内容。
  宽屏恢复进入手机前的侧栏可见性，不写桌面侧栏宽度或自动折叠右面板偏好。
- ResizablePanelGroup 仍使用原layoutId。手机 `persistLayout:false` 停止保存比例，退出后
  用同一个Group命令式句柄恢复进入前比例，不重挂载编辑器，不创建mobile布局持久化key。
- 手机主区单列，内容允许收缩到视口宽度；右面板若打开，用全宽覆盖呈现并保留返回操作，
  不把手机会话与文件预览各挤成半屏。不改变面板业务生命周期、PTY/preview owner。
- 手机软键盘/旋转resize不得触发桌面自动收面板策略；桌面原有行为保持。
- 顶栏复用现有 `simplifyForNarrowRemote` 规则，提供可触达的侧栏/新建入口，不预留
  Electron窗控空白；主要操作不依赖hover。
- 输入区使用已有 `text-mobile-input-safe` 16px兼容token，避免iOS focus zoom；
  首屏/切会话不自动弹软键盘（接通现有composerAutoFocus的mobile分支）。
  不修改 Enter发送/Shift+Enter换行的既有语义，不改CommandInbox或accepted队列。
- 草稿程序化恢复也必须遵守焦点门禁：Lexical的selectEnd/JSON选区会隐式聚焦，不能只改
  composerAutoFocus。手机未主动聚焦时，纯文本/mention恢复跳过DOM选区，JSON恢复不恢复选区；
  已主动编辑时和桌面保留原行为。发送后保持输入焦点的既有行为不改。
- 页面采用动态视口与safe-area inset；不禁止浏览器缩放。只在Web入口应用这些样式。
- 设置页仍复用既有响应式布局，本片不重做设置导航、不大改UI样式。

## 事件顺序

```text
同一 Web entry → 同一 services/Root/App
  → viewport(仅表现事实) → WorkspaceShellLayout
     进入手机：记录原侧栏可见性 → 收起（既有开合owner）
     菜单点击：同一sidebar以Dialog抽屉展开 → 选择任务/新建 → 关闭
     文件预览：同一side pane覆盖主区 → 返回会话
     回宽屏：恢复原侧栏可见性，保留原宽度
  → 同一 composer/draft/store → 同一 Host → 同一 runtime admission
```

`desktop-continuous` / `web-remote-replayable` 交付路径均未改变。响应式状态不得成为业务事实。

## 接口与验证

- `useMobileWebViewport()`：SSR安全，订阅单一media query，入口标记缺失时始终false。
- 布局适配通过已有sidebar/sidepane props与回调，不新增平台RPC。
- 真实Chromium回归：390×844、320×640、窄屏高度变化、宽屏1280×860、窄桌面模式。
  覆盖初始抽屉收起、菜单打开/遮罩/Escape关闭、任务选择后关闭、侧栏不挤会话、预览返回、
  无横向溢出、桌面偏好不变、编辑16px且初始不抢焦点。仅测试临时数据与loopback。
- 复用真实App/shell测试装配，重型业务叶子用既有fake services/叶子替换；不将组件E2E说成
  真机或真实模型往返。真实Web入口启动冒烟验证入口标记/viewport且不新增托管路径。
- `pnpm typecheck`、`pnpm lint`0/0、格式棘轮、architecture零新增、Web build、相关UI测试。
  文件新增均≤400行，不放宽基线。

## 验证边界

- 手机布局守卫复用真实Web入口、App/shell、WorkspaceHeader、AnimatedSidePanePanel、Lexical；
  仅任务目录/重型业务叶子与服务用fake。任务选择用无对应投影的身份触发fail-closed，
  只证明“选择意图先收抽屉”，不冒充真实会话导航成功。
- 独立焦点守卫挂真实ConversationComposer，验证文本/JSON/mention草稿恢复与重挂载均不抢手机
  焦点，桌面默认聚焦作为正向对照；未复制纯函数作为替身。
- 抽屉关闭时侧栏展示子树随Dialog卸载，侧栏业务投影仍在原store；不承诺保留局部滚动位置。
- 观测到桌面 `autoFocusEnabled:false` 仍可能因既有Lexical恢复路径聚焦。本片只修手机分支，
  不宣称已修桌面后台pane抢焦点问题。

## 本轮实测

- `pnpm test:web-profile-mobile`：14项单测 + 两个真实Chromium守卫通过，已接入desktop CI。
  320/390/1280、窄Electron-like、手机冷启动、抽屉、真实预览与返回、草稿不重挂载/不丢失、
  桌面localStorage key与比例不变均有断言。
- `pnpm typecheck`、`pnpm lint`（0 warnings / 0 errors）、`pnpm verify:pre-push`、Web build通过。
  Web build仍有体积/无效动态导入等构建warning，不是lintwarning。
- 既有app-shell-full-view、side-pane-full-view、workbench-split-guard、真实Web入口冒烟通过。
- `gate:knip`仍失败11条：stash掉本片后逐项相同，属于base已有Desktop/Agent等导出；
  本片新增项已清零，没有改knip棘轮基线。新fixture只在knip入口声明，不忽略诊断。
- 独立验收无阻断。一次重型浏览器运行在读侧栏box-model时超时，顺序重跑通过；读取改为同页
  getBoundingClientRect，未增加重试或放宽超时。真实手机键盘/公网/首条模型消息未测。
- 本片未滚版本、未出新安装包；relay改动仍隔离暂存，没有混入。

## 范围外

relay迁移/B5删除、远端workspace scope、真实公网TLS、iOS/Android软键盘真机行为、复杂多分屏
触屏手势均不在本片内。浏览器测试不能代替手机真机验收。
