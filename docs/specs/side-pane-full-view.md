# Side Pane 完整视图（S11-A）

父规格：[3.16 后续切片](../.agents/specs/upstream-3.16-project-ui.md) §2。行为来源：上游 3.16.2
`3c5b2276` 的 `docs/ui/side-pane-full-view.md` 与 `packages/ui/src/side-pane-full-view/`。
本仓差异：**保留**下游 workbench 多 pane 分屏；不采纳上游同批的“拆 split pane 入口下线”。

## 目标

右侧面板可以临时占满“左侧任务列表以外”的全部内容区：中间对话列不再占布局空间，当前对话成为
面板 tab 栏的第一个 tab，并在面板 tab 上方提供浮动输入窗口。左侧任务列表与左上角按钮组保持原样。

```
普通视图                                    完整视图
┌────────┬────────────────┬───────────┐    ┌────────┬──────────────────────────────┐
│ 任务列表 │ WorkspaceHeader │ [tabs][⤢][◫]│    │ 任务列表 │ [💬 对话][tab…][+]     [⤡][◫] │
│        │ 对话            │ 面板内容    │    │        │ 面板内容（或对话全宽）           │
│        │ 终端            │            │    │        │            ┌──────────────┐ │
└────────┴────────────────┴───────────┘    │        │            │ 浮动输入窗口    │ │
                                            └────────┴────────────┴──────────────┴─┘
```

## 状态归属

| 状态                                         | 所有者                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| 完整视图记录（surface + floating）           | `taskSidePaneMemory.sidePaneFullViewByOwner[ownerTaskId ?? "__draft__"]` |
| 浮窗吸附位置（7 选 1，全局偏好）             | `localStorage["zcode:side-pane-full-view:floating-anchor"]`              |
| 回答气泡（按对话 owner）                     | 宿主组件内内存 `ReadonlyMap<ownerKey, FloatingAnswerBubbleState>`        |
| 拖动中的坐标、操作栏是否显示、输入区实测高度 | 宿主组件内临时状态（不记忆）                                             |
| 侧栏显隐/宽度、面板占比、终端开合            | 原所有者，完整视图**只读**，进入/退出不写回                              |

只读派生：

```
完整视图生效 = 桌面端 && 面板打开 && 当前 owner 有记录 && 单 pane
WorkspaceHeader 显示 = 普通视图 && !完整视图生效
浮窗显示 = 完整视图生效 && surface === "side-pane"
面板外框 absolute inset-0 = 完整视图生效
面板 resize handle 显示 = 面板可见 && !完整视图生效
```

- 内存 key 复用既有 `buildTaskSidePaneMemoryKey`（`workspaceIdentity?.trim() || workspacePath`，
  不含 taskId），对话 owner 复用 `sidePaneCollapsedByOwner` 的同一 key（正式任务 taskId，
  草稿 `__draft__`）。**不新增第二所有者**，也不把 taskId 拼进 workspace 内存 key——
  否则同 workspace 内切任务会串到另一份记录，跨 workspace 同任务 id 会互相泄漏。
- 记录只在 renderer 内存里，按 workspace 做 LRU（沿用 `TASK_SIDE_PANE_MEMORY_MAX_ENTRIES`）；
  刷新/重启后不保留。吸附位置偏好是全局的，不随对话切换。
- 同一 owner 下，面板由开变关（◫ 或关闭最后一个 tab）立即清除该 owner 的记录，不用延时，
  也不靠重挂载修布局；再次打开面板不会回到完整视图。
- owner 切换（切任务/切草稿）时面板开合随 owner 恢复，**不**清除任何记录；切回原 owner 恢复
  原 surface 与浮窗形态。
- 面板关闭时按快捷键：先写入记录再打开面板（记录先落内存，面板展开后即生效）。

## 进入与退出

| 动作                                                                   | 结果                                       |
| ---------------------------------------------------------------------- | ------------------------------------------ |
| 面板右上角「进入完整视图」按钮（面板开关左侧）、`⇧⌘F` / `Ctrl+Shift+F` | 进入：surface = 面板 tab，浮窗收起态       |
| 同一按钮（此时为「退出完整视图」）、同一快捷键                         | 退出：回到原三栏布局                       |
| 面板开关 ◫ / 关闭最后一个面板 tab                                      | 关闭面板并立即退出完整视图                 |
| 点对话 tab / 菜单「在完整视图中打开」                                  | surface = conversation（对话全宽，含终端） |
| 点任意面板 tab                                                         | surface = side-pane，浮窗出现              |

- 快捷键命令 id `toggleSidePaneFullView`，默认 `CmdOrCtrl+Shift+f`，可在设置页改键。
  既有绑定核对：`findInTask` 是 `CmdOrCtrl+f`（无 Shift），保留键黑名单含
  `CmdOrCtrl+Shift+r/i/j/c` 与 `CmdOrCtrl+Shift+F1..F12`，均不与本键冲突；
  `SHORTCUT_COMMANDS` 内无重复物理绑定（单测穷举）。
- **仅桌面端**：`enabled = Boolean(isDesktop) && !webRemoteControlWorkspaceSwitcher`。
  Web / 手机远控不渲染入口按钮、不注册快捷键处理器（handler 为 null 时不消费按键）、
  设置页不显示该行。
- 退出不改任何原有状态：侧栏显隐/宽度、对话列与面板占比、终端开合都沿用进入前的值。

## 单实例

```
WorkspaceShellLayout（React 树在三种形态下相同）
└─ content / ResizablePanelGroup（已保存的 panel 占比不写入）
   ├─ conversation-column
   │   └─ SidePaneFullViewConversationHost（固定存在的包装层）
   │       ├─ normal：静态布局 h-full
   │       ├─ conversation：fixed 铺满面板内容区（slot）
   │       └─ floating：fixed 按吸附位置浮在 slot 内
   ├─ 面板 panel：完整视图中外框 absolute inset-0（不改库管理的 flex）
   └─ ResizableHandle：完整视图中隐藏
```

- 对话区只有一个 `SessionPane` 实例。宿主**只改定位方式**，不移动 DOM、不重新挂载、不复制
  composer；草稿、光标、滚动位置、上传中的附件因此只有一份。
- 面板宽度：完整视图不改 react-resizable-panels 管理的 flex。库以各 panel `offsetWidth`
  之和作为 group 尺寸，把对话列 CSS 压成 0 会让面板从收起到展开时 group 尺寸为 0、resize
  得到 NaN。因此对话列保持原宽度，只把面板外框改成 `absolute inset-0` 铺满整行。
- 宿主通过 ResizeObserver 读 slot 的窗口坐标并写到宿主 style（DOM 布局投影，不进 React
  state），窗口 resize / 面板 resize 都重新测量。

## 多 pane（本仓差异）

- 分屏（workbench 多 pane）与完整视图不能安全共存：浮窗只承载一个对话。因此**多 pane 时
  入口显式禁用**（按钮 disabled + 提示「分屏下不可用」），`enabled` 派生为 `paneCount === 1`。
- 禁用不改变任何分屏状态：不合并、不关闭 split pane、不改分屏比例。
- 新建分屏只有一个派生来源：shell 从现有 `useSidePaneFullView` controller 只读得到
  `splitEntryEnabled = !isFullView`，经 `V4SplitPaneEntryContext` 的同一个 value 同时下发给
  侧栏与对话区；`canCreateWorkbenchSplit({ splitEntryEnabled, paneCount, maxPanes })` 统一裁决。
  不持久化第二份开关，也不把 DOM 查询当作策略。
- 覆盖所有新建入口：
  - 任务行右键「在分屏打开」与任务行拖拽源（`enabled` / `canOpenSession` 关闭）；
  - 对话边缘 dragover offer 与 drop 提交（`V4WorkspaceChatArea` 的 `canDropSession` /
    `handleDropSession`）；
  - pane 头「向右/向下分屏」（`canSplit` 不再只看 pane 上限）；
  - shell 的程序化入口（`canOpenSessionInSplitPane` / `handleOpenSessionInSplitPane`）。
- 拖拽中途进入完整视图：offer 立即撤回；drop 提交时用 render 期 ref 重验当前派生值，
  已开始的拖拽不能落成新分屏，也不静默改变分屏布局。
- 回到单 pane / 退出完整视图后入口恢复；未进入完整视图的普通多 pane 分屏行为不变。

## 浮动输入窗口

```
 收起（失焦）              收起 + 操作栏（聚焦）           展开
 ┌──────────────────────┐  ┌──────────────────────┐     ┌──────────────────────┐
 │[+] 输入…   [控件][↑] │  │ [−] [⌃]            [⠿] │     │ [−] [⌄]            [⠿] │
 └──────────────────────┘  │╭────────────────────╮│     │ 窄消息流               │
                           ││[+] 输入… [控件][↑]││     │╭────────────────────╮│
                           │╰────────────────────╯│     ││[+] 输入… [控件][↑]││
                           └──────────────────────┘     │╰────────────────────╯│
                                                          └──────────────────────┘
```

- 收起态：只露出 `SessionPane` 底部输入区（`[data-v4-composer-dock]`）。宿主从自己的子树
  测量该 dock 高度（ResizeObserver），不读取也不改写 `SessionPane` 内部状态——权限/问答卡片
  替换输入框时 dock 变高，浮窗随之变高。内部内容始终按浮窗宽度排版并贴底。
- 对话侧通过 `ConversationPanePresentationContext` 读到 `presentation: "floating"`：
  - 输入框切到单行布局（`data-composer-layout="inline"`）：`[+] 输入区 [控件][发送]` 同一行，
    输入区至少占一半宽度；控件放不下时沿用工具栏逐级收起规则（先收文字，最后只留图标）。
    单行与普通两行共用同一棵 DOM 树，切 surface 不重新挂载编辑器，草稿/光标/撤销历史保留。
  - 对话运行时占位显示「工作中 {时长}」，时长与流式消息里的运行中 work segment 同值，
    复用 `formatConversationWorkDuration` 与时间线已有的每秒刷新时钟；没有时长时沿用原占位。
  - 输入区不再位于消息滚动容器内：仍是同一个 DOM 节点，改为相对时间线根节点贴底；
    滚动容器底边让出「输入区高度 + 12px」，消息底部再留 16px，滚动条止于输入框上方；
    浮窗形态不加消息层底部渐隐遮罩。
  - 草稿项目栏、草稿推荐提示不进入浮窗（切到对话 tab 再选择）；空会话也不居中，输入区始终贴底。
- 数据来源唯一：时间线最后一个回合的 `turnKey`、运行状态、运行时长和最终回答取自同一个
  render unit，由 `resolveConversationLatestTurnSummary` 一次性上报给 `SessionPane`，
  再经 `reportFloatingStatus` 交给宿主；不建立第二套 stream 聚合或独立计时器。
  状态带当前对话 owner，旧 owner 的迟到摘要不会混进新会话；只有焦点 pane 上报。
- 回答气泡：浮窗收起态下，一轮回答结束（出现一个已结束、最终回答为 complete、且不同于基线的
  回合）时，在浮窗上方（顶部吸附位置时在下方）显示纯文本前两行，不显示图标和标题。
  基线：浮窗第一次看到某个 owner 时，已结束的回合算看过，正在运行的回合不算；离开浮窗形态时
  清空基线，回到浮窗重新建立，所以在对话 tab 里看过的回答不会弹出。气泡只在内存里按 owner 记录，
  点左上角 × 或点气泡（同时展开消息流）才消失；发送下一条消息不会清除，下一轮回答结束后替换。
  展开态和最小化时隐藏但不清除。
- 最小化时出现新的权限 / 问答请求自动恢复为收起态，卡片替换输入框（同一份 DOM）。
  只响应新的 `blockingInteractionId`：同一请求等待期间用户再次最小化不会被反复弹开。
- 操作栏只有按钮：左「−」最小化、「⌃/⌄」展开或收起消息流；右 ⠿ 是拖动柄与菜单二合一
  （移动 <4px 视为点击开菜单：「在完整视图中打开」「最小化编辑器」）。不显示任务标题。
  空白处无点击行为；`onMouseDown` 阻止抢焦点。展开态操作栏常显。
- 最小化：48×48 圆钮固定显示聊天图标，运行中时显示旋转 loading（与操作栏同一
  `snapshot.control.canStop` 状态源）。
  点圆钮 → 收起 + 操作栏，并把焦点交给输入框（`data-testid="v4-composer-input"`）。
  最小化 ↔ 恢复之间几何直接到位并从吸附角缩放淡入（150ms）；最小化期间输入层保持浮窗宽度
  排版，不按 48px 重排。
- 拖动 ⠿ 或圆钮超过 4px：浮窗跟随指针（只写 style，不 setState），松手吸附到最近的
  7 个位置之一并持久化；拖动期间关闭 left/top/width/height 过渡。
- 吸附位置：左上、右上、左中、右中、左下、下中、右下；与 slot 边缘 16px。
  顶部位置向下展开，底部位置向上展开，中部居中。展开态宽 `min(560, slotW-32)`、
  高 `min(640, slotH-32)`；slot 过窄时收缩到 `slotW-32`。

## 与既有交互的边界

- 焦点：浮窗形态下 Esc 停止 agent 依赖焦点在对话 DOM 内，浮窗仍是同一份 DOM。
- 键盘：拖动柄与圆钮支持 Enter/Space 触发（圆钮恢复）。
- 主题/语言/缩放：复用 Button/ControlHintTooltip/tokens 与既有 i18n namespace
  `sidePane.fullView.*`；所有 JSX 为 `.tsx`，不新增任意字号的 UI 文本。
- 面板关闭按钮位置不变；完整视图按钮在面板开关左侧。
- 侧栏收起时 tab 栏左侧按 `WorkspaceHeader` 同一规则为按钮组留白
  （shell 内 `resolveFullViewTabBarLeadingInsetClass`，与 Header 同一组固定值）；
  侧栏展开时不额外留白。

## 对话侧润色（已纳入）

以下行为由对话 owner 通过 `ConversationPanePresentationContext` 实现；完整视图模块只提供
展示形态、宿主与上报接口，不读取 `SessionPane` / `ConversationTimeline` 的私有状态：

- `ConversationComposer` 的 `layout` / `workingDurationMs`：浮窗单行输入与「工作中 {时长}」占位。
- `ConversationTimeline` 的 `floatingComposerDock` / `onComposerDockHeightChange` /
  `onLatestTurnSummaryChange`：输入区贴底测量、滚动容器让位、最后回合摘要上报。
- `SessionPane` 只做接线：同一实例读取 `presentation`，把焦点 pane 的运行状态、阻塞交互、
  owner 与最后回合摘要交给宿主；不新增第二套会话状态或计时器。
- 宿主用 `reduceFloatingAnswerBubbles` 推进回答气泡；权限/问答替换输入框时仍由同一份 DOM 承载。

`contract.ts` 因此包含 answer-bubble / pane-presentation 类型；宿主仍只通过
`[data-v4-composer-dock]` 读取高度，不改 `SessionPane` 内部。

## 验收

- 纯模型：7 个吸附位置坐标、最近吸附点、clamp、transform-origin、最小化↔恢复几何、
  dock 高度裁剪、`resolveEffectiveSidePaneFullView`、面板开→关退出规则、
  回答气泡基线/替换/消除/离开浮窗重设、回答纯文本预览；最小化时「同一 owner 的新阻塞交互
  才自动恢复」由 `shouldRestoreFloatingFromMinimized` 覆盖 owner 隔离/同一请求重复上报/非最小化。
- 时间线摘要：最后回合的 turnKey/运行态/时长/最终回答同源；运行中或回答未 complete 不弹气泡。
- 内存：owner 隔离（taskId / `__draft__`）、workspace key 复用（identity || path）、
  LRU、跨 workspace 同 taskId 不泄漏、peek 不创建条目。
- 快捷键：`toggleSidePaneFullView` 在表内、默认 `CmdOrCtrl+Shift+f`、无重复物理绑定。
- 隔离浏览器 E2E（真实生产组件：`AnimatedSidePanePanel`、`SidePaneFullViewConversationHost`、
  `useSidePaneFullView`、`taskSidePaneMemory`、`useAppKeyboard`、真实
  `react-resizable-panels` 面板组、真实 `ChatPromptEditor`；临时 profile、loopback、真实 desktop 构建的
  styles）：进入/退出、两 surface、浮窗三形态、拖动吸附 + 偏好持久化、最小化恢复、关闭面板退出、
  切 owner 记忆、窗口 resize、单实例（草稿/滚动/上传保持）、多 pane 禁用入口、非桌面端无入口/无快捷键、
  亮暗 + 中英双语；浮窗单行布局与运行/阻塞交互上报经同一宿主契约断言。
- 分屏守卫：`canCreateWorkbenchSplit` 纯函数覆盖单/多 pane、完整视图生效与 pane 上限；
  组件 E2E `scripts/ci/workbench-split-guard-smoke.mjs` 使用真实 `V4WorkspaceChatArea`、
  `V4SplitPaneEntryContext`、`paneLayoutStore`、`workbenchSessionPlacement`、
  `useSidePaneFullView`，仅把 `SessionPane` / `V4PaneConversationProvider` 换成展示桩，覆盖
  pane 头分屏入口、dragover offer、drop 提交与「拖拽中途进入完整视图」重验，并断言普通
  多 pane 仍可拆分。
- 结构集成守卫 `scripts/ci/app-shell-full-view-smoke.mjs`：真实 `App` / `WorkspaceShellLayout` /
  `useSidePaneFullView` / `taskSidePaneMemory` 走真实 workspace 启动路径；只替换重型展示叶子
  （`WorkspaceSidebar`、`WorkspaceHeader`、`V4WorkspaceChatArea` 等）与面板内容。断言进入/
  关闭面板退出/owner 记录清除/多 pane 完整视图入口禁用，以及同一个 split entry 派生值在
  侧栏消费者处的变化。它不覆盖真实对话内容与真实分屏落点，后者由上面的组件 E2E 覆盖。

实现：`scripts/ci/side-pane-full-view-smoke.mjs`（完整视图场景）+ `packages/ui/test/fixtures/side-pane-full-view.jsx`
（shell 外壳与可断言的对话内容桩）；`scripts/ci/app-shell-full-view-smoke.mjs`（App shell 结构集成守卫）；
`scripts/ci/workbench-split-guard-smoke.mjs`（分屏新建入口守卫）。夹具用 root 已声明的
vite/esbuild 打包，样式取 `packages/desktop/out/renderer/assets/styles-*.css`；夹具是浏览器真实入口，
在 `knip.json` 的 `packages/ui` 工作区以精确 entry 登记给静态分析（不新增 ignore）。

## 已知剩余缺口（下一片）

- 未跑 Electron 整机 E2E；现有两个浏览器守卫使用真实 App/shell 与真实分屏宿主，但对话叶子、
  面板内容与 `SessionPane` 仍是展示桩，不能替代整机回归。
- 浮窗的滚动容器让位/消息遮罩由 `ConversationTimeline` 生产实现覆盖；宿主级 E2E 仍以组件夹具为主，
  `SessionPane` 到宿主的真实 pending interaction 上报由类型检查 + 纯模型（owner/新请求判断）覆盖，
  未在真实 session 上跑 composer/answer bubble 全链路。
