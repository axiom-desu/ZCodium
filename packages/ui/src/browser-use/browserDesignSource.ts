// 浏览器设计工具的宿主侧纯函数：页面 URL → 本机 HTML 路径、样式值白名单、
// 以及「按页面给的元素路径在源码里找到同一个元素，只改它的 style 属性」。
// 页面内容不可信：这里不执行任何页面代码，也不根据页面选择写入路径；locate 对不上就返回 null。

import { locateDesignSourceElement } from "@/browser-use/browserDesignHtml.js";

const DESIGN_SOURCE_MAX_DEPTH = 64;

export const DESIGN_STYLE_PROPERTIES = [
  "fontSize",
  "color",
  "backgroundColor",
  "borderRadius",
  "padding",
  "opacity",
  "fontWeight",
  "textAlign",
] as const;

export type DesignStyleProperty = (typeof DESIGN_STYLE_PROPERTIES)[number];

export type DesignStyleDraft = Partial<Record<DesignStyleProperty, string>>;

export interface DesignSourceStep {
  tag: string;
  index: number;
  siblings: number;
}

export interface DesignSourcePath {
  steps: DesignSourceStep[];
  id: string | null;
  className: string | null;
}

export interface DesignStyleChange {
  property: DesignStyleProperty;
  cssProperty: string;
  before: string;
  after: string;
}

export interface DesignSourcePreview {
  content: string;
  changes: DesignStyleChange[];
}

const CSS_PROPERTY_NAMES: Record<DesignStyleProperty, string> = {
  fontSize: "font-size",
  color: "color",
  backgroundColor: "background-color",
  borderRadius: "border-radius",
  padding: "padding",
  opacity: "opacity",
  fontWeight: "font-weight",
  textAlign: "text-align",
};

const TAG_RE = /^[a-z][a-z0-9-]{0,63}$/u;
const LENGTH_VALUE_RE =
  /^(?:0|\d+(?:\.\d+)?(?:px|rem|em|%))(?: (?:\d+(?:\.\d+)?(?:px|rem|em|%)|0)){0,3}$/u;
const COLOR_VALUE_RE =
  /^(?:#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)|transparent)$/iu;
const INVALID_VALUE_RE = /[;<>{}@\\\n\r]|url\s*\(|expression\s*\(|javascript:/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

/** 页面返回的源码路径只当定位提示；形状不对就当没找到。 */
export function isDesignSourcePath(value: unknown): value is DesignSourcePath {
  if (!isRecord(value) || !Array.isArray(value.steps)) return false;
  if (value.steps.length > DESIGN_SOURCE_MAX_DEPTH) return false;
  for (const step of value.steps) {
    if (!isRecord(step)) return false;
    const tag = readString(step.tag, 64);
    if (!tag || !TAG_RE.test(tag)) return false;
    if (typeof step.index !== "number" || typeof step.siblings !== "number") return false;
    if (!Number.isInteger(step.index) || !Number.isInteger(step.siblings)) return false;
    if (step.siblings < 1 || step.siblings > 10_000) return false;
    if (step.index < 0 || step.index >= step.siblings) return false;
  }
  const id = value.id;
  const className = value.className;
  return (
    (id === null || readString(id, 500) !== null) &&
    (className === null || readString(className, 500) !== null)
  );
}

/** file:// 本机 HTML 才可写回；其他协议、伪造 host 或非 HTML 一律返回 null。 */
export function designSourcePathFromUrl(pageUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "file:" || parsed.host) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  // file:///C:/dir/a.html 的 pathname 是 /C:/dir/a.html
  const localPath = /^\/[a-zA-Z]:\//u.test(pathname) ? pathname.slice(1) : pathname;
  return /\.html?$/iu.test(localPath) ? localPath : null;
}

/**
 * 面板输入的样式值白名单。页面 DOM 和用户输入都走这里：只要出现第二条声明、规则块、
 * url() / expression() / javascript: 或换行，就整体拒绝，不进入预览也不进入源码。
 */
export function sanitizeDesignStyleValue(
  property: DesignStyleProperty,
  rawValue: string,
): string | null {
  const value = rawValue.trim();
  if (!value || value.length > 120 || INVALID_VALUE_RE.test(value)) return null;
  switch (property) {
    case "fontSize":
    case "borderRadius":
    case "padding":
      return LENGTH_VALUE_RE.test(value) ? value : null;
    case "color":
    case "backgroundColor":
      return COLOR_VALUE_RE.test(value) ? value : null;
    case "opacity": {
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 && number <= 1 ? value : null;
    }
    case "fontWeight":
      return /^(?:[1-9]00|normal|bold)$/u.test(value) ? value : null;
    case "textAlign":
      return /^(?:left|center|right|justify|start|end)$/u.test(value) ? value : null;
  }
}

export function getDesignStyleChanges(
  initial: DesignStyleDraft,
  draft: DesignStyleDraft,
): DesignStyleChange[] {
  const changes: DesignStyleChange[] = [];
  for (const property of DESIGN_STYLE_PROPERTIES) {
    const before = initial[property] ?? "";
    const rawAfter = draft[property];
    if (rawAfter === undefined || rawAfter.trim() === before.trim()) continue;
    const after = sanitizeDesignStyleValue(property, rawAfter);
    if (!after || after === before) continue;
    changes.push({
      property,
      cssProperty: CSS_PROPERTY_NAMES[property],
      before,
      after,
    });
  }
  return changes;
}

function splitStyleDeclarations(style: string): string[] {
  const declarations: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < style.length; index += 1) {
    const char = style[index];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === ";" && depth === 0) {
      declarations.push(style.slice(start, index));
      start = index + 1;
    }
  }
  declarations.push(style.slice(start));
  return declarations.map((declaration) => declaration.trim()).filter(Boolean);
}

function declarationName(declaration: string): string {
  const colon = declaration.indexOf(":");
  return colon < 0 ? "" : declaration.slice(0, colon).trim().toLowerCase();
}

function escapeAttributeValue(value: string, quote: string): string {
  return value.replaceAll("&", "&amp;").replaceAll(quote, quote === '"' ? "&quot;" : "&#39;");
}

/** 只改目标元素开始标签里的 style 属性；源码其余字节（包括换行、缩进、实体）原样保留。 */
export function applyDesignStyleEdits(
  source: string,
  path: DesignSourcePath,
  styles: DesignStyleDraft,
): DesignSourcePreview | null {
  const located = locateDesignSourceElement(source, path);
  if (!located) return null;
  const before = located.style?.value ?? "";
  const declarations = splitStyleDeclarations(before);
  const changes: DesignStyleChange[] = [];
  for (const property of DESIGN_STYLE_PROPERTIES) {
    const rawValue = styles[property];
    if (rawValue === undefined) continue;
    const value = sanitizeDesignStyleValue(property, rawValue);
    if (!value) continue;
    const cssProperty = CSS_PROPERTY_NAMES[property];
    const existing = declarations.find(
      (declaration) => declarationName(declaration) === cssProperty,
    );
    const existingValue = existing?.slice(existing.indexOf(":") + 1).trim() ?? "";
    if (existingValue === value) continue;
    for (let index = declarations.length - 1; index >= 0; index -= 1) {
      if (declarationName(declarations[index] ?? "") === cssProperty) declarations.splice(index, 1);
    }
    const important = /!\s*important\s*$/iu.test(existingValue) ? " !important" : "";
    declarations.push(`${cssProperty}: ${value}${important}`);
    changes.push({ property, cssProperty, before: existingValue, after: value });
  }
  if (changes.length === 0) return { content: source, changes };
  const nextStyle = declarations.join("; ");
  const quote = located.style
    ? source.slice(located.style.valueStart - 1, located.style.valueStart) === "'"
      ? "'"
      : '"'
    : '"';
  const escaped = escapeAttributeValue(nextStyle, quote);
  if (located.style) {
    const content =
      source.slice(0, located.start) +
      source.slice(located.start, located.style.start) +
      `style=${quote}${escaped}${quote}` +
      source.slice(located.style.end);
    return { content, changes };
  }
  const selfClosing = source.slice(located.start, located.startTagEnd).trimEnd().endsWith("/>");
  const insertAt = located.startTagEnd - (selfClosing ? 2 : 1);
  const content =
    source.slice(0, insertAt) + ` style=${quote}${escaped}${quote}` + source.slice(insertAt);
  return { content, changes };
}
