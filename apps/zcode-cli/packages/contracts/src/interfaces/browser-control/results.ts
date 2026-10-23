import type { TraceContext } from "../../tracing/tracer.js";
import type { BrowserBackendType, BrowserViewportSize } from "./context.js";
import type { BrowserCommand } from "./commands.js";

export type BrowserErrorCode =
  | "backend_unavailable"
  | "capability_unsupported"
  | "duplicate_request_id"
  | "ref_not_found"
  | "navigation_blocked"
  | "timeout"
  | "renderer_unreachable"
  | "cancelled"
  | "execution_error";

export interface BrowserPageState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  scrollX?: number;
  scrollY?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface BrowserSnapshotElement {
  ref: string;
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  selector: string;
  xpath: string;
  rect: { x: number; y: number; width: number; height: number };
  inViewport: boolean;
  parentRef?: string;
  framePath?: string;
  attributes?: Record<string, string>;
}

export interface BrowserSnapshotDomNode {
  tag: string;
  depth: number;
  inViewport: boolean;
  ref?: string;
  role?: string;
  name?: string;
  text?: string;
  attributes?: Record<string, string>;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  elements: BrowserSnapshotElement[];
  truncated: boolean;
  dom?: BrowserSnapshotDomNode[];
  domTruncated?: boolean;
}

/** 受控 tab 摘要（list 命令返回）；与 @zcode/shared 的 browserTabSummarySchema 镜像同步。 */
export interface BrowserTabSummary {
  tabId: string;
  url: string;
  title: string;
  /** guest 当前真实 CSS viewport；normal/free-size 均必须返回。 */
  viewport: BrowserViewportSize;
  /** 当前可见/激活的内置浏览器 tab；agent 用它优先读取用户正在看的页面。 */
  active?: boolean;
  lifecycle?: "active" | "deliverable" | "handoff";
}

export interface BrowserUserTabInfo {
  id: string;
  lastOpened?: string;
  tabGroup?: string;
  title?: string;
  url?: string;
}

export interface BrowserResponseMeta {
  browserUse: true;
  backendType: BrowserBackendType;
  browserId: string;
  browserGeneration: number;
  openTabIds: string[];
  tabId?: string;
  currentUrl?: string;
  lifecycle?: "active" | "deliverable" | "handoff" | "closed";
}

/** JS 弹窗信息（getDialog 返回）。 */
export interface BrowserDialog {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt?: string;
}

export interface BrowserRecordingArtifact {
  path: string;
  mimeType: "video/webm";
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  frameCount: number;
}

export interface BrowserRecordingJob {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  phase: "preparing" | "capturing" | "finalizing" | "completed" | "failed" | "cancelled";
  progress: number;
  startedAt: number;
  updatedAt: number;
  artifact?: BrowserRecordingArtifact;
  error?: string;
}

export interface BrowserCommandResult {
  ok: boolean;
  state?: BrowserPageState;
  snapshot?: BrowserSnapshot;
  image?: { base64: string; mimeType: "image/png" };
  /** list 命令返回：当前会话窗口下所有受控 tab 的摘要。 */
  tabs?: BrowserTabSummary[];
  userTabs?: BrowserUserTabInfo[];
  tab?: BrowserTabSummary;
  /** evaluate 返回：页面表达式的可 JSON 序列化结果。 */
  value?: unknown;
  /** elementInfo 返回：坐标命中元素的信息（未命中则省略）。 */
  element?: BrowserSnapshotElement;
  /** getDialog 返回：当前 JS 弹窗信息；无弹窗时为 null。 */
  dialog?: BrowserDialog | null;
  recording?: BrowserRecordingJob;
  error?: { code: BrowserErrorCode; message: string; sideEffect?: "none" | "uncertain" };
  meta?: BrowserResponseMeta;
  elapsedMs: number;
}

export interface BrowserControlExecuteInput {
  /** 精确 runtime backend id；不能只传 iab/extension/cdp family。 */
  browserId: string;
  browserGeneration: number;
  sessionId: string;
  turnId?: string;
  command: BrowserCommand;
  traceContext?: TraceContext;
  signal?: AbortSignal;
}

export interface BrowserControlListInput {
  sessionId: string;
  turnId?: string;
  traceContext?: TraceContext;
  signal?: AbortSignal;
}

/** 子会话 Browser 请求的 tab 归属：子会话自己（dwf 子代理）或父会话（core Agent 子代理）。 */
