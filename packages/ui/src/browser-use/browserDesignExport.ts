import type {
  CaptureBrowserGuestPageClip,
  CaptureBrowserGuestPageRequest,
  CaptureBrowserGuestPageResult,
  IPlatformService,
  PrintBrowserGuestPageRequest,
  PrintBrowserGuestPageResult,
  SaveFileRequest,
  SaveFileResult,
} from "@zcode/shared";
import type { DesignElementRect } from "@/browser-use/browserDesignInspectScript.js";

// 设计工具条上的页面截图 / 元素截图 / 导出 PDF。
// 请求与结果类型全部直接使用 @zcode/shared 的公共契约（BC8 收口）：UI 不再声明同名私有结构，
// 也不会出现「按钮显示可用但平台结果形状不匹配」的假入口。PDF 只走 main 的公开打印端口
// printBrowserGuestPage，不声明 <webview>.printToPDF。能力缺席时按钮显示为不可用，不伪造成功。

export type BrowserDesignExportKind = "pdf" | "png";

/**
 * 平台端口：字段就是 IPlatformService 上同名方法的公共契约。
 * 只有方法真实存在才进入端口对象；UI 据此决定按钮可用性。
 */
export interface BrowserDesignExportPort {
  captureBrowserGuestPage?: (
    request: CaptureBrowserGuestPageRequest,
  ) => Promise<CaptureBrowserGuestPageResult>;
  printBrowserGuestPage?: (
    request: PrintBrowserGuestPageRequest,
  ) => Promise<PrintBrowserGuestPageResult>;
  saveFile?: (request: SaveFileRequest) => Promise<SaveFileResult>;
}

/** 发起导出时从真实 View 取的归属快照：owner/session/tab/generation，用于迟到结果作废。 */
export interface BrowserDesignExportScope {
  browserKey: string;
  sessionId: string;
  workspaceKey: string;
  residencyGeneration: number | null;
  webviewGeneration: number;
}

/** 当前 tab 的当前代 guest；webContentsId 来自 renderer 实际上报给 main 的 id。 */
export interface BrowserDesignExportGuest {
  webContentsId: number;
  title: string;
}

export interface BrowserDesignExportSnapshot {
  scope: BrowserDesignExportScope;
  guest: BrowserDesignExportGuest;
}

export type BrowserDesignExportResult =
  | { status: "saved"; path: string }
  | { status: "canceled" }
  /** tab/页面/guest 在导出过程中换了代，本次结果作废（不保存）。 */
  | { status: "stale" }
  | { status: "unavailable"; kind: BrowserDesignExportKind }
  | { status: "failed"; error: string };

const UNSAFE_FILE_NAME_CHARS = /[\\/:*?"<>|\p{Cc}]+/gu;
const MAX_FILE_STEM_LENGTH = 120;

/**
 * 等两帧再读视口：与元素截图脚本一致，保证高亮层已经离开画面，并让 viewportWidth/Height
 * 反映取帧时真实的 CSS 视口（不是 React 状态里的旧值）。
 */
const BROWSER_DESIGN_VIEWPORT_SCRIPT = `new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    resolve({ width: window.innerWidth, height: window.innerHeight });
  }));
})`;

export function resolveBrowserDesignPlatformPort(
  platform: IPlatformService,
): BrowserDesignExportPort {
  const capture = platform.captureBrowserGuestPage;
  const print = platform.printBrowserGuestPage;
  const save = platform.saveFile;
  return {
    ...(typeof capture === "function" ? { captureBrowserGuestPage: capture.bind(platform) } : {}),
    ...(typeof print === "function" ? { printBrowserGuestPage: print.bind(platform) } : {}),
    ...(typeof save === "function" ? { saveFile: save.bind(platform) } : {}),
  };
}

function isValidGuestId(webContentsId: number): boolean {
  return Number.isInteger(webContentsId) && webContentsId > 0;
}

/** 视口读数来自页面，按不可信输入校验：只接受正数有限值。 */
export function parseBrowserDesignViewport(
  value: unknown,
): { height: number; width: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const { width, height } = value as { width?: unknown; height?: unknown };
  if (typeof width !== "number" || typeof height !== "number") return null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

export async function readBrowserDesignViewport(
  executeJs: (script: string) => Promise<unknown>,
): Promise<{ height: number; width: number } | null> {
  try {
    return parseBrowserDesignViewport(await executeJs(BROWSER_DESIGN_VIEWPORT_SCRIPT));
  } catch {
    return null;
  }
}

export function canExportBrowserDesignPage({
  guest,
  kind,
  port,
}: {
  guest: BrowserDesignExportGuest;
  kind: BrowserDesignExportKind;
  port: BrowserDesignExportPort;
}): boolean {
  if (!port.saveFile || !isValidGuestId(guest.webContentsId)) return false;
  if (kind === "pdf") return typeof port.printBrowserGuestPage === "function";
  return typeof port.captureBrowserGuestPage === "function";
}

/** 元素截图需要 PNG 取帧能力 + 已选中元素的真实 boundingClientRect。 */
export function canExportBrowserDesignElement({
  elementRect,
  guest,
  port,
}: {
  elementRect: DesignElementRect | null;
  guest: BrowserDesignExportGuest;
  port: BrowserDesignExportPort;
}): boolean {
  if (!canExportBrowserDesignPage({ guest, kind: "png", port })) return false;
  if (!elementRect) return false;
  return (
    Number.isFinite(elementRect.width) &&
    Number.isFinite(elementRect.height) &&
    elementRect.width > 0 &&
    elementRect.height > 0
  );
}

/**
 * 归属快照是否仍然指向同一个页面：任一字段变化都说明这是上一页/上一代的结果。
 * 只比较值，不做模糊匹配——主进程另有 owner/lease 校验兜底。
 */
export function isSameBrowserDesignExportSnapshot(
  left: BrowserDesignExportSnapshot,
  right: BrowserDesignExportSnapshot,
): boolean {
  return (
    left.guest.webContentsId === right.guest.webContentsId &&
    left.scope.browserKey === right.scope.browserKey &&
    left.scope.sessionId === right.scope.sessionId &&
    left.scope.workspaceKey === right.scope.workspaceKey &&
    left.scope.residencyGeneration === right.scope.residencyGeneration &&
    left.scope.webviewGeneration === right.scope.webviewGeneration
  );
}

function browserDesignExportFileName(title: string, kind: BrowserDesignExportKind): string {
  const stem = title
    .replace(UNSAFE_FILE_NAME_CHARS, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_FILE_STEM_LENGTH)
    .trim();
  return `${stem || "page"}.${kind}`;
}

async function readExportBytes({
  elementRect,
  isCurrent,
  kind,
  port,
  readViewport,
  snapshot,
}: {
  elementRect: DesignElementRect | null;
  isCurrent: () => boolean;
  kind: BrowserDesignExportKind;
  port: BrowserDesignExportPort;
  readViewport: () => Promise<{ height: number; width: number } | null>;
  snapshot: BrowserDesignExportSnapshot;
}): Promise<ArrayBuffer | BrowserDesignExportResult> {
  const webContentsId = snapshot.guest.webContentsId;
  if (kind === "pdf") {
    if (!port.printBrowserGuestPage) return { status: "unavailable", kind };
    const printed = await port.printBrowserGuestPage({ webContentsId });
    if (!isCurrent()) return { status: "stale" };
    if (!printed.success || !printed.data) {
      return { status: "failed", error: printed.error ?? "print_failed" };
    }
    return printed.data;
  }

  if (!port.captureBrowserGuestPage) return { status: "unavailable", kind };
  let clip: CaptureBrowserGuestPageClip | undefined;
  if (elementRect) {
    const viewport = await readViewport();
    if (!isCurrent()) return { status: "stale" };
    if (!viewport) return { status: "failed", error: "viewport_unavailable" };
    // 页面 rect 是 CSS px（可能部分在视口外）；是否越界由 main 按实际帧验证，UI 不静默裁剪。
    clip = {
      x: elementRect.x,
      y: elementRect.y,
      width: elementRect.width,
      height: elementRect.height,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
    };
  }
  const captured = await port.captureBrowserGuestPage(
    clip ? { webContentsId, clip } : { webContentsId },
  );
  if (!isCurrent()) return { status: "stale" };
  if (!captured.success || !captured.data) {
    return { status: "failed", error: captured.error ?? "capture_failed" };
  }
  return captured.data;
}

export async function exportBrowserDesignPage({
  elementRect = null,
  isCurrent,
  kind,
  port,
  readViewport,
  snapshot,
}: {
  elementRect?: DesignElementRect | null;
  isCurrent: () => boolean;
  kind: BrowserDesignExportKind;
  port: BrowserDesignExportPort;
  readViewport: () => Promise<{ height: number; width: number } | null>;
  snapshot: BrowserDesignExportSnapshot;
}): Promise<BrowserDesignExportResult> {
  if (!isValidGuestId(snapshot.guest.webContentsId)) {
    return { status: "failed", error: "guest_not_ready" };
  }
  if (elementRect && kind !== "png") {
    return { status: "unavailable", kind };
  }
  if (!port.saveFile) return { status: "unavailable", kind };
  try {
    const bytes = await readExportBytes({
      elementRect,
      isCurrent,
      kind,
      port,
      readViewport,
      snapshot,
    });
    if (!(bytes instanceof ArrayBuffer)) return bytes;
    // 保存前再确认一次：等待取帧/打印期间 tab 换代的，不允许把旧页面写到磁盘。
    if (!isCurrent()) return { status: "stale" };
    const saved = await port.saveFile({
      data: bytes,
      suggestedName: browserDesignExportFileName(snapshot.guest.title, kind),
    });
    if (saved.canceled) return { status: "canceled" };
    if (!saved.success || !saved.path) {
      return { status: "failed", error: saved.error ?? "save_failed" };
    }
    return { status: "saved", path: saved.path };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
