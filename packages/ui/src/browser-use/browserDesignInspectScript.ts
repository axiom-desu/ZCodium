import {
  DESIGN_STYLE_PROPERTIES,
  isDesignSourcePath,
  sanitizeDesignStyleValue,
  type DesignSourcePath,
  type DesignStyleDraft,
} from "@/browser-use/browserDesignSource.js";

// 设计工具的单次点选脚本。页面内容不可信：脚本只读元素、临时打一个宿主随机标记，
// 返回值和源码路径都只是「定位提示」；宿主会重新校验路径并只在源码里按同一路径找到元素时才写回。
// 传输复用现有 UnifiedBrowserView 的 webview.executeJavaScript，不新增 preload 或 postMessage 桥。

export const DESIGN_TARGET_ATTRIBUTE = "data-zcode-design-target";
const DESIGN_OVERLAY_ATTRIBUTE = "data-zcode-design-overlay";

export interface DesignElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesignInspectSelection {
  selector: string;
  tagName: string;
  sourcePath: DesignSourcePath;
  styleAttribute: string | null;
  editable: DesignStyleDraft;
  rect: DesignElementRect | null;
}

type DesignInspectResult =
  | { status: "selected"; selection: DesignInspectSelection }
  | { status: "cancelled" }
  | { status: "blocked" };

interface DesignPreviewCommand {
  selector: string;
  /** 点选时元素原始 style；null 表示本来没有 style 属性 */
  styleAttribute: string | null;
  /** CSS 属性名 → 值 */
  styles: Record<string, string>;
}

const TAG_RE = /^[a-z][a-z0-9-]{0,63}$/u;
const SELECTOR_RE = /^\[data-zcode-design-target="[a-z0-9-]{1,64}"\]$/u;
const MAX_STYLE_ATTRIBUTE = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStyleDraft(value: unknown): DesignStyleDraft {
  if (!isRecord(value)) return {};
  const draft: DesignStyleDraft = {};
  for (const property of DESIGN_STYLE_PROPERTIES) {
    const rawValue = value[property];
    if (typeof rawValue !== "string" || rawValue.length > 120) continue;
    const sanitized = sanitizeDesignStyleValue(property, rawValue);
    if (sanitized) draft[property] = sanitized;
  }
  return draft;
}

function readRect(value: unknown): DesignElementRect | null {
  if (!isRecord(value)) return null;
  const numbers = [value.x, value.y, value.width, value.height];
  if (!numbers.every((number) => typeof number === "number" && Number.isFinite(number))) {
    return null;
  }
  return {
    x: numbers[0] as number,
    y: numbers[1] as number,
    width: numbers[2] as number,
    height: numbers[3] as number,
  };
}

/** 页面可以伪造任何字段；这里逐项校验并限长，非法结果按取消处理。 */
export function parseBrowserDesignInspectResult(value: unknown): DesignInspectResult {
  if (!isRecord(value)) return { status: "cancelled" };
  if (value.status === "cancelled") return { status: "cancelled" };
  if (value.status === "blocked") return { status: "blocked" };
  if (value.status !== "selected" || !isRecord(value.selection)) {
    return { status: "cancelled" };
  }
  const selection = value.selection;
  const selector = selection.selector;
  const tagName = selection.tagName;
  const styleAttribute = selection.styleAttribute;
  if (typeof selector !== "string" || !SELECTOR_RE.test(selector)) return { status: "cancelled" };
  if (typeof tagName !== "string" || !TAG_RE.test(tagName)) return { status: "cancelled" };
  if (
    styleAttribute !== null &&
    (typeof styleAttribute !== "string" || styleAttribute.length > MAX_STYLE_ATTRIBUTE)
  ) {
    return { status: "cancelled" };
  }
  if (!isDesignSourcePath(selection.sourcePath)) return { status: "cancelled" };
  const editable = readStyleDraft(selection.editable);
  if (Object.keys(editable).length === 0) return { status: "cancelled" };
  return {
    status: "selected",
    selection: {
      selector,
      tagName,
      sourcePath: selection.sourcePath,
      styleAttribute: styleAttribute === null ? null : styleAttribute,
      editable,
      rect: readRect(selection.rect),
    },
  };
}

export function buildBrowserDesignInspectScript(): string {
  const targetAttribute = JSON.stringify(DESIGN_TARGET_ATTRIBUTE);
  const overlayAttribute = JSON.stringify(DESIGN_OVERLAY_ATTRIBUTE);
  const propertyNames = JSON.stringify(DESIGN_STYLE_PROPERTIES);
  return `(() => {
  const previousDispose = window.__zcodeDesignInspectDispose;
  if (typeof previousDispose === "function") previousDispose();
  return new Promise((resolve) => {
    const targetAttribute = ${targetAttribute};
    const overlayAttribute = ${overlayAttribute};
    const properties = ${propertyNames};
    const nonce = Math.random().toString(36).slice(2, 14);
    const selector = '[' + targetAttribute + '="' + nonce + '"]';
    const overlay = document.createElement('div');
    overlay.setAttribute(overlayAttribute, '1');
    overlay.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:1px solid #2563eb;background:rgba(37,99,235,.08);box-sizing:border-box;display:none';
    document.documentElement.appendChild(overlay);
    let finished = false;
    const isOwnNode = (node) => node instanceof Element && node.hasAttribute(overlayAttribute);
    const childrenOf = (parent) => Array.from(parent.children).filter((child) => !isOwnNode(child));
    const sourcePath = (element) => {
      const steps = [];
      let node = element;
      while (node && node !== document.documentElement) {
        const parent = node.parentElement;
        if (!parent) return null;
        const children = childrenOf(parent);
        const index = children.indexOf(node);
        if (index < 0) return null;
        steps.unshift({ tag: node.tagName.toLowerCase(), index, siblings: children.length });
        node = parent;
      }
      if (node !== document.documentElement || steps.length > 64) return null;
      return {
        steps,
        id: element.getAttribute('id'),
        className: element.getAttribute('class'),
      };
    };
    const read = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      element.setAttribute(targetAttribute, nonce);
      const path = sourcePath(element);
      if (!path) return null;
      return {
        selector,
        tagName: element.tagName.toLowerCase(),
        sourcePath: path,
        styleAttribute: element.getAttribute('style'),
        editable: {
          fontSize: style.fontSize,
          color: style.color,
          backgroundColor: style.backgroundColor,
          borderRadius: style.borderRadius,
          padding: style.padding,
          opacity: style.opacity,
          fontWeight: style.fontWeight,
          textAlign: style.textAlign,
        },
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    };
    const cleanup = (result) => {
      if (finished) return;
      finished = true;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (window.__zcodeDesignInspectDispose === dispose) delete window.__zcodeDesignInspectDispose;
      if (window.__zcodeDesignInspectReady) delete window.__zcodeDesignInspectReady;
      resolve(result);
    };
    const dispose = () => cleanup({ status: 'cancelled' });
    const onMove = (event) => {
      const element = document.elementFromPoint(event.clientX, event.clientY);
      if (!(element instanceof Element) || isOwnNode(element) || element === document.documentElement || element === document.body) {
        overlay.style.display = 'none';
        return;
      }
      const rect = element.getBoundingClientRect();
      overlay.style.display = 'block';
      overlay.style.left = rect.left + 'px';
      overlay.style.top = rect.top + 'px';
      overlay.style.width = rect.width + 'px';
      overlay.style.height = rect.height + 'px';
    };
    const onClick = (event) => {
      const element = document.elementFromPoint(event.clientX, event.clientY);
      if (!(element instanceof Element) || isOwnNode(element) || element === document.documentElement || element === document.body) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const selection = read(element);
      cleanup(selection ? { status: 'selected', selection } : { status: 'blocked' });
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cleanup({ status: 'cancelled' });
      }
    };
    window.__zcodeDesignInspectDispose = dispose;
    window.__zcodeDesignInspectReady = true;
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  });
})()`;
}

export function buildBrowserDesignPreviewScript(command: DesignPreviewCommand): string {
  return `(() => {
  const element = document.querySelector(${JSON.stringify(command.selector)});
  if (!(element instanceof HTMLElement)) return false;
  const styleAttribute = ${JSON.stringify(command.styleAttribute)};
  if (styleAttribute === null) element.removeAttribute('style');
  else element.setAttribute('style', styleAttribute);
  const styles = ${JSON.stringify(command.styles)};
  for (const [name, value] of Object.entries(styles)) element.style.setProperty(name, value);
  return true;
})()`;
}

export function buildBrowserDesignReadStyleScript(selector: string): string {
  return `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  return element instanceof HTMLElement ? element.getAttribute('style') : null;
})()`;
}

export function buildBrowserDesignDisposeScript(
  selector: string,
  styleAttribute: string | null,
): string {
  return `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!(element instanceof HTMLElement)) return false;
  const styleAttribute = ${JSON.stringify(styleAttribute)};
  if (styleAttribute === null) element.removeAttribute('style');
  else element.setAttribute('style', styleAttribute);
  element.removeAttribute(${JSON.stringify(DESIGN_TARGET_ATTRIBUTE)});
  return true;
})()`;
}
