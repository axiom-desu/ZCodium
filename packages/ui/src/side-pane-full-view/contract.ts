// side-pane-full-view 模块契约（spec：docs/specs/side-pane-full-view.md）。
// 只放类型；运行时实现经 index.ts 暴露。

/** 完整视图的两个 surface：对话全宽，或面板 tab + 浮动输入窗口。 */
export type SidePaneFullViewSurface = "conversation" | "side-pane";

/** 浮窗三形态：收起（只露输入区）、展开（窄消息流）、最小化（圆形按钮）。 */
export type SidePaneFullViewFloating = "collapsed" | "expanded" | "minimized";

export interface SidePaneFullViewState {
  readonly surface: SidePaneFullViewSurface;
  readonly floating: SidePaneFullViewFloating;
}

export interface SidePaneFullViewController {
  /** 生效中的完整视图；面板关闭、平台不支持、多 pane 或当前 owner 无记录时为 null。 */
  readonly fullView: SidePaneFullViewState | null;
  /** 入口是否可用（桌面端 && 单 pane）；false 时不渲染入口、快捷键处理器为 null。 */
  readonly enabled: boolean;
  /**
   * 写入当前 owner 的进入记录。面板关闭时也写，供「面板关闭 + 快捷键」先落记录再开面板；
   * 重复调用幂等（已有记录时不变）。
   */
  enter(): void;
  exit(): void;
  toggle(): void;
  setSurface(surface: SidePaneFullViewSurface): void;
  setFloating(floating: SidePaneFullViewFloating): void;
}

/** 浮窗吸附位置：左/中/右 × 上/中/下 的七种组合。 */
export type FloatingAnchor =
  | "top-left"
  | "top-right"
  | "left-center"
  | "right-center"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

/** 宿主定位形态：普通布局、铺满面板内容区、浮在面板内容区内。 */
export type SidePaneFullViewHostMode = "normal" | "conversation" | "floating";

/** 面板 tab 栏里的对话 tab 与入口按钮的只读派生。 */
export interface SidePaneFullViewPanelState {
  readonly surface: SidePaneFullViewSurface;
  /** 当前对话标题（草稿显示「新任务」）。 */
  readonly conversationTitle: string;
  /** 与 WorkspaceHeader 一致的按钮组留白（侧栏收起时非空）。 */
  readonly leadingInsetClassName?: string;
  readonly onSelectSurface: (surface: SidePaneFullViewSurface) => void;
}

export interface SidePaneFullViewToggle {
  readonly active: boolean;
  readonly onToggle: () => void;
  readonly shortcutLabel?: string;
  /** 多 pane 等不能共存时显式禁用入口，不静默改变分屏布局。 */
  readonly disabledReason?: string;
}

export type ConversationPanePresentation = "docked" | "floating";

export interface FloatingAnswer {
  readonly rowId: number;
  readonly text: string;
}

export interface ConversationPaneFloatingStatus {
  readonly running: boolean;
  readonly blockingInteractionId: string | null;
  /** 当前对话 owner（正式任务 taskId，草稿 `__draft__`）；回答气泡按它分开记录。 */
  readonly ownerKey: string;
  /**
   * 时间线最后一个回合的运行状态与最终回答，二者取自同一个 render unit；
   * 尚无时间线上报时为 null。
   */
  readonly latestTurn: {
    readonly turnKey: string | null;
    readonly running: boolean;
    readonly answer: FloatingAnswer | null;
  } | null;
}

/**
 * 每个 owner 的回答气泡。seenTurnKey 是已经算作「看过」的最后一个回合：
 * undefined 表示还没建立基线（第一次看到该 owner，或刚回到浮窗形态）；null 表示基线时正在运行、
 * 还没有看过的已结束回合。之后出现 turnKey 不同、已结束且有最终回答的回合就弹出。
 * 不依赖观察到「运行中」：很快结束的回合可能在一次渲染里就从未开始变成已结束。
 */
export interface FloatingAnswerBubbleState {
  readonly seenTurnKey: string | null | undefined;
  readonly answer: FloatingAnswer | null;
}

export interface ConversationPanePresentationValue {
  readonly presentation: ConversationPanePresentation;
  /** 焦点 pane 上报运行状态与阻塞交互，供浮窗操作栏和最小化按钮展示。 */
  readonly reportFloatingStatus: (status: ConversationPaneFloatingStatus) => void;
  /** 焦点 pane 上报底部输入区实测高度，浮窗收起态按它裁剪。 */
  readonly reportComposerDockHeight: (heightPx: number) => void;
}
