import fs from "node:fs";
import path from "node:path";

// 解析 contracts 入口的公开导出面（名字 + type/value 分类），供回归测试与基线生成共用。
// 只跟随本包内的相对 `export *` / `export { ... } from`，不解析第三方包。
export const SURFACE_ENTRIES = [
  "events/event-reducer",
  "interfaces/browser-control.port",
  "interfaces/session-store.port",
  "model/index",
  "workflow/index",
] as const;

export type ExportKind = "type" | "value" | "both";

const DECL_PATTERN =
  /export\s+(?:declare\s+)?(interface|type|const|let|var|function|class|enum)\s+([A-Za-z0-9_$]+)/g;
const STAR_RE = /export\s+\*\s+from\s+["']([^"']+)["']/g;
const NAMED_RE = /export\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
const LOCAL_NAMED_RE = /export\s+(type\s+)?\{([^}]*)\}\s*;/g;

function kindOf(decl: string): ExportKind {
  if (decl === "interface" || decl === "type") return "type";
  if (decl === "class" || decl === "enum") return "both";
  return "value";
}

function resolveModule(fromFile: string, spec: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), spec.replace(/\.js$/u, ".ts"));
  return fs.existsSync(base) ? base : undefined;
}

function collect(file: string, seen: Set<string>, out: Map<string, ExportKind>): void {
  if (seen.has(file)) return;
  seen.add(file);
  const text = fs.readFileSync(file, "utf8");

  for (const match of text.matchAll(DECL_PATTERN)) {
    out.set(match[2]!, kindOf(match[1]!));
  }
  for (const match of text.matchAll(STAR_RE)) {
    const target = resolveModule(file, match[1]!);
    if (target) collect(target, seen, out);
  }
  for (const match of text.matchAll(NAMED_RE)) {
    const kind: ExportKind = match[1] ? "type" : "value";
    for (const part of match[2]!.split(",")) {
      const alias = part
        .trim()
        .split(/\s+as\s+/u)
        .pop()
        ?.trim();
      if (alias) out.set(alias, kind);
    }
  }
  for (const match of text.matchAll(LOCAL_NAMED_RE)) {
    const kind: ExportKind = match[1] ? "type" : "value";
    for (const part of match[2]!.split(",")) {
      const alias = part
        .trim()
        .split(/\s+as\s+/u)
        .pop()
        ?.trim();
      if (alias) out.set(alias, kind);
    }
  }
}

export function exportSurface(srcRoot: string): Record<string, Array<[string, ExportKind]>> {
  const surface: Record<string, Array<[string, ExportKind]>> = {};
  for (const entry of SURFACE_ENTRIES) {
    const out = new Map<string, ExportKind>();
    collect(path.join(srcRoot, `${entry}.ts`), new Set(), out);
    surface[entry] = [...out.entries()].sort(([a], [b]) => a.localeCompare(b));
  }
  return surface;
}
