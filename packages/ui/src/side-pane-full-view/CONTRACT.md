# side-pane-full-view

Side Pane 完整视图：面板占满窗口内容区，当前对话成为面板 tab 栏的第一个 tab，并在面板 tab 上方
提供浮动输入窗口。行为合同见 `docs/specs/side-pane-full-view.md`。

不变量：

- 唯一状态 owner 是 `useSidePaneFullView`，记录按 workspace + 对话 owner 存在
  `taskSidePaneMemory.sidePaneFullViewByOwner`；面板 tab 栏、WorkspaceHeader、浮窗显隐都只读派生，
  不回写侧栏/面板宽度/终端等原有状态。
- 对话区只有一个 `SessionPane` 实例；宿主只改变定位方式，不移动 DOM、不重新挂载，草稿、滚动与
  上传中的附件因此只有一份。
- 不覆盖 react-resizable-panels 管理的 panel flex：库以各 panel 的 `offsetWidth` 之和作为 group
  尺寸，压成 0 会让 resize 得到 NaN。完整视图通过面板外框 `absolute inset-0` 铺满 Group。
- 浮窗的收起高度来自宿主子树里 `[data-v4-composer-dock]` 的实测高度，不读取 `SessionPane` 内部状态。
- 对话侧通过 `ConversationPanePresentationContext` 读取展示形态；`SessionPane` / `ConversationTimeline`
  与 `ConversationComposer` 只在浮窗形态切换单行输入、工作时长占位、输入区贴底与最后回合上报。
  宿主用 `reportFloatingStatus` 的 owner + 最后回合摘要推进回答气泡，并在最小化时只对新的阻塞交互
  恢复为收起态；不建立第二套 stream 聚合或独立计时器。
- 仅桌面端；Web / 手机远控不渲染入口、不注册快捷键。多 pane 分屏时入口显式禁用，不改变分屏布局。
- 完整视图生效期间禁止新建分屏：shell 从现有 controller 派生唯一的 `enabled`，经
  `V4SplitPaneEntryContext` 同一个 value 同时约束侧栏菜单/拖拽源与对话区 pane 头按钮、
  dragover offer、drop 提交；drop 提交用 render 期 ref 重验，拖拽中途进入完整视图也不会落成新分屏。
  不新增第二份持久化开关或 DOM 查询策略。
- 最小化时只有同一 owner 的新阻塞交互才恢复为收起态；判定由 `shouldRestoreFloatingFromMinimized`
  纯函数覆盖，恢复动作仍只写浮窗形态，不建立第二套会话状态。
- 快捷键 `toggleSidePaneFullView` 在 `packages/shared/src/shortcutCommands.ts` 命令表登记，
  处理器只在桌面端注册。

交集：

- 布局宿主 `app-shell/WorkspaceShellLayout.tsx` 负责把宿主固定在 panel 内容区上方；
  `app-shell/AnimatedSidePanePanel.tsx` 负责对话 tab、入口按钮与面板外框定位。
- `conversationPanePresentation.ts` 是宿主与对话侧的唯一展示形态上下文；
  `contract.ts` 定义上报类型与气泡状态，`model.ts` 提供纯函数推进气泡。
