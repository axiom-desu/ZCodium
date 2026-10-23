import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { RgArg } from "ripgrep";
import type { FileSystemSearchTextRequest, FileSystemTextSearchOutputMode } from "@zcode/contracts";
import { fileTypeGlobPatterns } from "./file-types.js";
import { VCS_DIRECTORIES_TO_EXCLUDE } from "./file-walk.js";

interface RipgrepSearchPlan {
  args: RgArg[];
  outputRoot: string;
  preopens: Record<string, string>;
}

export function createRipgrepSearchPlan(
  path: string,
  rootInfo: Awaited<ReturnType<typeof stat>>,
  request: FileSystemSearchTextRequest,
  mode: FileSystemTextSearchOutputMode,
): RipgrepSearchPlan {
  const outputRoot = rootInfo.isDirectory() ? path : dirname(path);
  const target = rootInfo.isDirectory() ? "." : basename(path);
  const args: RgArg[] = [
    "--no-config",
    "--hidden",
    "--color",
    "never",
    "--no-heading",
    "--with-filename",
    "--max-columns",
    "500",
  ];

  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
    args.push("--glob", `!${dir}`, "--glob", `!**/${dir}/**`);
  }

  if (request.multiline) {
    args.push("-U", "--multiline-dotall");
  }

  if (request.ignoreCase) {
    args.push("-i");
  }

  if (mode === "content") {
    args.push("--json");
    if (request.onlyMatching) {
      args.push("--only-matching");
    }
    addRipgrepContextArgs(args, request);
  } else {
    args.push("-c");
  }

  if (request.glob) {
    addRipgrepGlobArgs(args, request.glob);
  }
  if (request.type) {
    addRipgrepTypeArgs(args, request.type);
  }

  args.push("-e", request.pattern.trim(), "--", target);

  return {
    args,
    outputRoot,
    preopens: { ".": outputRoot },
  };
}

function addRipgrepContextArgs(args: RgArg[], request: FileSystemSearchTextRequest): void {
  if (request.context !== undefined) {
    args.push("-C", String(request.context));
    return;
  }
  if (request.beforeContext !== undefined) {
    args.push("-B", String(request.beforeContext));
  }
  if (request.afterContext !== undefined) {
    args.push("-A", String(request.afterContext));
  }
}

function addRipgrepGlobArgs(args: RgArg[], glob: string): void {
  for (const pattern of splitRipgrepGlobPatterns(glob)) {
    args.push("--glob", pattern);
  }
}

function splitRipgrepGlobPatterns(glob: string): string[] {
  const patterns: string[] = [];
  for (const rawPattern of glob.split(/\s+/)) {
    if (rawPattern.includes("{") && rawPattern.includes("}")) {
      patterns.push(rawPattern);
      continue;
    }
    patterns.push(...rawPattern.split(","));
  }
  return patterns.map((pattern) => pattern.trim()).filter(Boolean);
}

function addRipgrepTypeArgs(args: RgArg[], type: string): void {
  for (const pattern of fileTypeGlobPatterns(type)) {
    args.push("--glob", pattern);
  }
}
