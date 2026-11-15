import type { DesignSourcePath } from "@/browser-use/browserDesignSource.js";

// HTML 源码定位器：只用来在宿主源码里按页面给的路径找同一个元素。
// 不执行页面代码；路径对不上（标签、兄弟数、id/class）就返回 null，调用方不写。

const TAG_RE = /^[a-z][a-z0-9-]{0,63}$/u;
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title", "noscript", "template"]);
interface SourceAttribute {
  name: string;
  value: string;
  start: number;
  end: number;
  valueStart: number;
  valueEnd: number;
}

interface SourceElement {
  tagName: string;
  start: number;
  startTagEnd: number;
  attributes: SourceAttribute[];
  children: SourceElement[];
}

function readAttributes(source: string, start: number, end: number): SourceAttribute[] {
  const attributes: SourceAttribute[] = [];
  let index = start;
  while (index < end) {
    while (index < end && /\s/u.test(source[index] ?? "")) index += 1;
    if (index >= end || source[index] === "/" || source[index] === ">") break;
    const nameStart = index;
    while (index < end && !/[\s=/>]/u.test(source[index] ?? "")) index += 1;
    const name = source.slice(nameStart, index).toLowerCase();
    while (index < end && /\s/u.test(source[index] ?? "")) index += 1;
    if (source[index] !== "=") {
      attributes.push({
        name,
        value: "",
        start: nameStart,
        end: index,
        valueStart: index,
        valueEnd: index,
      });
      continue;
    }
    index += 1;
    while (index < end && /\s/u.test(source[index] ?? "")) index += 1;
    const quote = source[index] === '"' || source[index] === "'" ? source[index] : "";
    if (quote) index += 1;
    const valueStart = index;
    while (index < end && (quote ? source[index] !== quote : !/[\s>]/u.test(source[index] ?? ""))) {
      index += 1;
    }
    const valueEnd = index;
    if (quote && index < end) index += 1;
    attributes.push({
      name,
      value: source.slice(valueStart, valueEnd),
      start: nameStart,
      end: index,
      valueStart,
      valueEnd,
    });
  }
  return attributes;
}

function findTagEnd(source: string, start: number): number {
  let quote = "";
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return index + 1;
  }
  return source.length;
}

function parseSourceElements(source: string): SourceElement[] {
  const roots: SourceElement[] = [];
  const stack: SourceElement[] = [];
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("<", index);
    if (open < 0) break;
    if (source.startsWith("<!--", open)) {
      const close = source.indexOf("-->", open + 4);
      index = close < 0 ? source.length : close + 3;
      continue;
    }
    if (source.startsWith("<!", open) || source.startsWith("<?", open)) {
      const close = source.indexOf(">", open + 2);
      index = close < 0 ? source.length : close + 1;
      continue;
    }
    const closing = source[open + 1] === "/";
    const nameStart = open + (closing ? 2 : 1);
    let nameEnd = nameStart;
    while (nameEnd < source.length && /[a-zA-Z0-9:-]/u.test(source[nameEnd] ?? "")) nameEnd += 1;
    const tagName = source.slice(nameStart, nameEnd).toLowerCase();
    if (!TAG_RE.test(tagName)) {
      index = open + 1;
      continue;
    }
    const startTagEnd = findTagEnd(source, nameEnd);
    if (closing) {
      const found = stack.findLastIndex((element) => element.tagName === tagName);
      if (found >= 0) stack.length = found;
      index = startTagEnd;
      continue;
    }
    const element: SourceElement = {
      tagName,
      start: open,
      startTagEnd,
      attributes: readAttributes(source, nameEnd, Math.max(nameEnd, startTagEnd - 1)),
      children: [],
    };
    const parent = stack.at(-1);
    if (parent) parent.children.push(element);
    else roots.push(element);
    index = startTagEnd;
    if (VOID_TAGS.has(tagName) || source.slice(open, startTagEnd).trimEnd().endsWith("/>")) {
      continue;
    }
    stack.push(element);
    if (RAW_TEXT_TAGS.has(tagName)) {
      const close = source.toLowerCase().indexOf(`</${tagName}`, index);
      index = close < 0 ? source.length : close;
    }
  }
  return roots;
}

function attributeValue(element: SourceElement, name: string): string | null {
  return element.attributes.find((attribute) => attribute.name === name)?.value ?? null;
}

interface LocatedSourceElement {
  start: number;
  startTagEnd: number;
  style: SourceAttribute | null;
}

export function locateDesignSourceElement(
  source: string,
  path: DesignSourcePath,
): LocatedSourceElement | null {
  const root = parseSourceElements(source).find((element) => element.tagName === "html");
  if (!root) return null;
  let current = root;
  for (const step of path.steps) {
    if (current.children.length !== step.siblings) return null;
    const next = current.children[step.index];
    if (!next || next.tagName !== step.tag) return null;
    current = next;
  }
  if (
    attributeValue(current, "id") !== path.id ||
    attributeValue(current, "class") !== path.className
  ) {
    return null;
  }
  return {
    start: current.start,
    startTagEnd: current.startTagEnd,
    style: current.attributes.find((attribute) => attribute.name === "style") ?? null,
  };
}
