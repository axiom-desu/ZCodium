// Side Pane 完整视图的纯模型：状态派生与浮窗几何（spec：docs/specs/side-pane-full-view.md）。
// 只做纯计算，不读写 DOM / 存储；宿主组件负责测量 slot 并把结果写成 style。
import type {
  ConversationPaneFloatingStatus,
  FloatingAnchor,
  FloatingAnswerBubbleState,
  SidePaneFullViewFloating,
  SidePaneFullViewHostMode,
  SidePaneFullViewState,
} from "@/side-pane-full-view/contract.js";

export const SIDE_PANE_FULL_VIEW_ENTER_STATE: SidePaneFullViewState = {
  surface: "side-pane",
  floating: "collapsed",
};

export const FLOATING_ANCHORS: readonly FloatingAnchor[] = [
  "top-left",
  "top-right",
  "left-center",
  "right-center",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

export const DEFAULT_FLOATING_ANCHOR: FloatingAnchor = "bottom-right";
export const FLOATING_MARGIN_PX = 16;
export const FLOATING_WIDTH_PX = 560;
export const FLOATING_EXPANDED_MAX_HEIGHT_PX = 640;
export const FLOATING_MINIMIZED_SIZE_PX = 48;
/** 指针移动不足该距离时，⠿ 与圆形按钮按点击处理。 */
export const FLOATING_DRAG_CLICK_THRESHOLD_PX = 4;
const FLOATING_HEADER_HEIGHT_PX = 40;
/** 操作栏隐藏时抽屉藏在输入框后面的高度；聚焦时从这里向上滑出。 */
const DRAWER_TUCK_UNDER_COMPOSER_PX = 16;

export interface FloatingRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface FloatingSize {
  readonly width: number;
  readonly height: number;
}

export interface FloatingPosition {
  readonly left: number;
  readonly top: number;
}

/** 浮窗几何：外层尺寸、内部内容高度、输入层裁剪高度与抽屉高度。 */
interface FloatingFrameMetrics {
  readonly width: number;
  readonly height: number;
  readonly paneHeight: number;
  readonly clipHeight: number;
  readonly drawerHeight: number;
}

export function resolveFloatingWidth(slotWidth: number): number {
  return Math.max(0, Math.min(FLOATING_WIDTH_PX, slotWidth - FLOATING_MARGIN_PX * 2));
}

function resolveFloatingExpandedHeight(slotHeight: number): number {
  return Math.max(
    0,
    Math.min(FLOATING_EXPANDED_MAX_HEIGHT_PX, slotHeight - FLOATING_MARGIN_PX * 2),
  );
}

export function clampFloatingPosition(
  position: FloatingPosition,
  slot: FloatingRect,
  size: FloatingSize,
): FloatingPosition {
  const maxLeft = slot.left + slot.width - size.width;
  const maxTop = slot.top + slot.height - size.height;
  return {
    left: Math.max(slot.left, Math.min(position.left, maxLeft)),
    top: Math.max(slot.top, Math.min(position.top, maxTop)),
  };
}

export function resolveFloatingPosition(
  anchor: FloatingAnchor,
  slot: FloatingRect,
  size: FloatingSize,
): FloatingPosition {
  const m = FLOATING_MARGIN_PX;
  const horizontal = anchor.includes("left")
    ? "start"
    : anchor.includes("right")
      ? "end"
      : "center";
  const vertical = anchor.startsWith("top")
    ? "start"
    : anchor.startsWith("bottom")
      ? "end"
      : "center";
  const left =
    horizontal === "start"
      ? slot.left + m
      : horizontal === "end"
        ? slot.left + slot.width - m - size.width
        : slot.left + (slot.width - size.width) / 2;
  const top =
    vertical === "start"
      ? slot.top + m
      : vertical === "end"
        ? slot.top + slot.height - m - size.height
        : slot.top + (slot.height - size.height) / 2;
  return clampFloatingPosition({ left, top }, slot, size);
}

/**
 * 最小化与恢复之间切换的缩放原点：圆形按钮与浮窗贴在同一个吸附角上，
 * 从这个角缩放，看起来是从按钮展开 / 收回按钮。
 */
export function resolveFloatingTransformOrigin(anchor: FloatingAnchor): string {
  const x = anchor.includes("left") ? "left" : anchor.includes("right") ? "right" : "center";
  const y = anchor.startsWith("top") ? "top" : anchor.startsWith("bottom") ? "bottom" : "center";
  return `${x} ${y}`;
}

/** 松手时按「窗口当前位置与各吸附位置静止坐标」的距离选最近的吸附点。 */
export function resolveNearestFloatingAnchor(
  position: FloatingPosition,
  slot: FloatingRect,
  size: FloatingSize,
): FloatingAnchor {
  let best: FloatingAnchor = DEFAULT_FLOATING_ANCHOR;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const anchor of FLOATING_ANCHORS) {
    const resting = resolveFloatingPosition(anchor, slot, size);
    const distance = Math.hypot(resting.left - position.left, resting.top - position.top);
    if (distance < bestDistance) {
      best = anchor;
      bestDistance = distance;
    }
  }
  return best;
}

export function parseFloatingAnchor(raw: unknown): FloatingAnchor | null {
  return typeof raw === "string" && (FLOATING_ANCHORS as readonly string[]).includes(raw)
    ? (raw as FloatingAnchor)
    : null;
}

/**
 * 浮窗外框几何。收起的输入层只露输入区（裁剪到实测 dock 高度），
 * 最小化固定 48×48；展开态内容高度为浮窗高减去操作栏高度。
 */
export function resolveFloatingFrameMetrics({
  slot,
  floating,
  headerVisible,
  composerDockHeightPx,
}: {
  slot: FloatingRect;
  floating: SidePaneFullViewFloating;
  headerVisible: boolean;
  composerDockHeightPx: number;
}): FloatingFrameMetrics {
  if (floating === "minimized") {
    return {
      width: FLOATING_MINIMIZED_SIZE_PX,
      height: FLOATING_MINIMIZED_SIZE_PX,
      paneHeight: FLOATING_MINIMIZED_SIZE_PX,
      clipHeight: FLOATING_MINIMIZED_SIZE_PX,
      drawerHeight: 0,
    };
  }
  const paneHeight = Math.max(
    0,
    resolveFloatingExpandedHeight(slot.height) - FLOATING_HEADER_HEIGHT_PX,
  );
  const headerHeight = headerVisible ? FLOATING_HEADER_HEIGHT_PX : 0;
  // 收起态外层就是输入框本身；展开态输入层内缩 1px，露出抽屉边框。
  const expanded = floating === "expanded";
  const clipHeight = expanded
    ? Math.max(0, paneHeight - 1)
    : Math.min(composerDockHeightPx, paneHeight);
  const height = headerHeight + (expanded ? paneHeight : clipHeight);
  return {
    width: resolveFloatingWidth(slot.width),
    height,
    paneHeight: expanded ? clipHeight : paneHeight,
    clipHeight,
    // 操作栏可见时抽屉延伸到浮窗底边：两侧边线连续，输入框像放在抽屉里。
    drawerHeight: headerVisible ? height : DRAWER_TUCK_UNDER_COMPOSER_PX,
  };
}

/** 宿主定位形态：无记录 = 普通布局。 */
export function resolveSidePaneFullViewHostMode(
  state: SidePaneFullViewState | null,
): SidePaneFullViewHostMode {
  if (!state) return "normal";
  return state.surface === "conversation" ? "conversation" : "floating";
}

/** 生效中的完整视图：入口可用、面板打开且当前 owner 有记录时才生效。 */
export function resolveEffectiveSidePaneFullView({
  enabled,
  isSidePaneOpen,
  stored,
}: {
  enabled: boolean;
  isSidePaneOpen: boolean;
  stored: SidePaneFullViewState | null;
}): SidePaneFullViewState | null {
  return enabled && isSidePaneOpen ? stored : null;
}

/**
 * 同一 owner 下面板由开变关即退出（◫、关闭最后一个 tab）。
 * owner 切换时面板开合随 owner 恢复，不代表用户关闭，不清除任何记录。
 */
export function shouldClearSidePaneFullViewOnPaneClose({
  previousScope,
  scope,
  wasSidePaneOpen,
  isSidePaneOpen,
  hasRecord,
}: {
  previousScope: string;
  scope: string;
  wasSidePaneOpen: boolean;
  isSidePaneOpen: boolean;
  hasRecord: boolean;
}): boolean {
  return previousScope === scope && wasSidePaneOpen && !isSidePaneOpen && Boolean(hasRecord);
}

interface FloatingBlockingInteractionSnapshot {
  readonly ownerKey: string;
  readonly interactionId: string | null;
}

/**
 * 最小化时只有同一 owner 出现「新的」阻塞交互才自动恢复为收起态。
 * 抽成纯函数是为了让 owner 隔离、同一请求重复上报、切 owner 迟到状态三条边界
 * 在真实宿主接线之外单独可测；不引入第二份会话状态。
 */
export function shouldRestoreFloatingFromMinimized({
  isMinimized,
  previous,
  next,
}: {
  isMinimized: boolean;
  previous: FloatingBlockingInteractionSnapshot;
  next: FloatingBlockingInteractionSnapshot;
}): boolean {
  if (!isMinimized) return false;
  if (previous.ownerKey !== next.ownerKey) return false;
  if (!next.interactionId) return false;
  return next.interactionId !== previous.interactionId;
}

/** 浮窗在非展开态只在浮窗内有焦点、菜单打开或拖动时显示操作栏。 */
export function resolveFloatingHeaderVisible({
  floating,
  focusWithin,
  menuOpen,
  dragging,
}: {
  floating: SidePaneFullViewFloating;
  focusWithin: boolean;
  menuOpen: boolean;
  dragging: boolean;
}): boolean {
  if (floating === "minimized") return false;
  return floating === "expanded" || focusWithin || menuOpen || dragging;
}

/**
 * 回答气泡状态推进：第一次看到某 owner 时建立基线（已结束的回合算看过）；之后出现 turnKey 不同、
 * 已结束且有最终回答的回合就弹出并记为看过，新回答替换旧回答。
 * 修复原因：曾要求先看到「运行中」再看到结束才弹出；回放或很快的回答在一次渲染批次里就结束，
 * 界面从未处于运行中，气泡永远不弹。
 */
export function reduceFloatingAnswerBubbles(
  bubbles: ReadonlyMap<string, FloatingAnswerBubbleState>,
  status: Pick<ConversationPaneFloatingStatus, "ownerKey" | "latestTurn">,
): ReadonlyMap<string, FloatingAnswerBubbleState> {
  const turn = status.latestTurn;
  if (!turn?.turnKey) return bubbles;
  const current = bubbles.get(status.ownerKey) ?? { seenTurnKey: undefined, answer: null };
  let next = current;
  if (current.seenTurnKey === undefined) {
    next = { ...current, seenTurnKey: turn.running ? null : turn.turnKey };
  } else if (!turn.running && turn.answer && turn.turnKey !== current.seenTurnKey) {
    next = { seenTurnKey: turn.turnKey, answer: turn.answer };
  }
  if (next === current) return bubbles;
  const updated = new Map(bubbles);
  updated.set(status.ownerKey, next);
  return updated;
}

/** 点 × 或点气泡：清除该 owner 的气泡，基线不变。 */
export function dismissFloatingAnswerBubble(
  bubbles: ReadonlyMap<string, FloatingAnswerBubbleState>,
  ownerKey: string,
): ReadonlyMap<string, FloatingAnswerBubbleState> {
  const current = bubbles.get(ownerKey);
  if (!current?.answer) return bubbles;
  const updated = new Map(bubbles);
  updated.set(ownerKey, { ...current, answer: null });
  return updated;
}

/**
 * 离开浮窗形态时清空所有基线（保留已弹出的气泡）：回到浮窗时重新建立，
 * 在对话 tab 里已经看过的回答不会再弹出。
 */
export function rebaselineFloatingAnswerBubbles(
  bubbles: ReadonlyMap<string, FloatingAnswerBubbleState>,
): ReadonlyMap<string, FloatingAnswerBubbleState> {
  if (![...bubbles.values()].some((bubble) => bubble.seenTurnKey !== undefined)) return bubbles;
  return new Map([...bubbles].map(([key, bubble]) => [key, { ...bubble, seenTurnKey: undefined }]));
}

/** 气泡里只放纯文本：去掉 markdown 的代码块、链接、标题、列表与强调标记，合并空白。 */
export function resolveFloatingAnswerPreview(markdown: string): string {
  return (
    markdown
      .replace(/```[\s\S]*?(```|$)/g, " ")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
      // 下划线不当作强调：回答里常有 snake_case 等代码标识符。
      .replace(/(\*\*|~~|\*)(\S(?:.*?\S)?)\1/g, "$2")
      .replace(/\s+/g, " ")
      .trim()
  );
}
