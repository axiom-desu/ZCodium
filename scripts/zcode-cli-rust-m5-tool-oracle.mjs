import { realpath, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { NodeFileSystemAdapter } from "../apps/zcode-cli/packages/adapters/src/fs/index.ts";
import { builtInTools } from "../apps/zcode-cli/packages/core/src/tool/handlers/index.ts";

const allowedNames = new Set(["Read", "Write", "Edit", "Glob", "Grep"]);
const handlers = new Map(
  builtInTools
    .filter((entry) => allowedNames.has(entry.metadata.name))
    .map((entry) => [entry.metadata.name, entry]),
);
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

async function assertPrivateWorkspace(cwd, actions) {
  const root = await realpath(cwd);
  const temp = await realpath(tmpdir());
  if (
    !inside(temp, root) ||
    !relative(temp, root).split(sep)[0].startsWith("zcode-rust-m5-tools-")
  ) {
    throw new Error("M5 oracle requires a private zcode-rust-m5-tools-* temporary workspace");
  }
  for (const { name, args } of actions) {
    if (!handlers.has(name)) throw new Error(`Unsupported M5 oracle tool: ${name}`);
    const path = resolve(root, args.file_path ?? args.path ?? ".");
    if (!inside(root, path)) throw new Error("M5 oracle path escapes its workspace");
    let parent = path;
    for (;;) {
      try {
        // 检查 symlink 的真实目标，防止测试入口借临时目录访问用户库。
        await lstat(parent);
        if (!inside(root, await realpath(parent)))
          throw new Error("M5 oracle symlink escapes its workspace");
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        parent = dirname(parent);
      }
    }
  }
  return root;
}

/** Live public ToolEntry handlers; no executor, permissions, provider or user store. */
export async function runTsOracle(cwd, actions) {
  const root = await assertPrivateWorkspace(cwd, actions);
  const context = {
    toolCallId: "m5-oracle",
    traceId: "m5-oracle",
    sessionId: "m5-oracle",
    turnId: "m5-oracle",
    abortSignal: new AbortController().signal,
    workingDirectory: root,
    workspaceRoot: root,
    fileSystemPort: new NodeFileSystemAdapter(),
    readFileState: new Map(),
  };
  const results = [];
  for (const { name, args } of actions) {
    const entry = handlers.get(name);
    try {
      const output = await entry.handler(args, context);
      results.push({ ok: true, output, content: entry.formatModelContent?.(output) });
    } catch (error) {
      results.push({
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: error?.code,
        },
      });
    }
  }
  return results;
}

if (process.argv.includes("--check")) {
  const cwd = process.argv[process.argv.indexOf("--check") + 1];
  if (!cwd) throw new Error("--check requires a temporary workspace path");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const { actions } = JSON.parse(input);
  process.stdout.write(`${JSON.stringify(await runTsOracle(cwd, actions))}\n`);
}
