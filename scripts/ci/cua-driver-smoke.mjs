import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { validateCuaDriverRuntime } from "../cua-driver-runtime-assets.mjs";
import { resolveDesktopProductIdentity } from "../../packages/desktop/scripts/desktop-product-identity.mjs";

const run = promisify(execFile);

// 交叉打包时 staged 资产按**目标** platform/arch 落盘（见 prepare-agent-node-bundle.mjs），
// 所以校验也必须用目标值，不能用 runner 自身的 process.arch。
function normalizeTargetOs(raw) {
  switch ((raw ?? "").toLowerCase()) {
    case "mac":
    case "macos":
    case "darwin":
    case "osx":
      return "darwin";
    case "win":
    case "windows":
    case "win32":
      return "win32";
    case "linux":
      return "linux";
    default:
      return undefined;
  }
}

function normalizeTargetArch(raw) {
  switch ((raw ?? "").toLowerCase()) {
    case "x64":
    case "amd64":
    case "x86_64":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    default:
      return undefined;
  }
}

function resolveCuaSmokeTarget() {
  const platform = normalizeTargetOs(process.env.ZCODE_TARGET_OS) ?? process.platform;
  const arch = normalizeTargetArch(process.env.ZCODE_TARGET_ARCH) ?? process.arch;
  return { platform, arch };
}

/**
 * Actual shipped files, isolated from the repository's ancestor node_modules. No screen capture.
 *
 * `filesOnly` 用于交叉架构打包（如在 x64 runner 上打 Windows arm64）：资产文件可以校验，
 * 但 arm64 原生库不可能被 x64 的 Node/Electron 加载，执行探针只能跳过。
 */
export async function smokeCuaDriverRuntime(
  pluginRoot,
  nodeExecutable = process.execPath,
  { filesOnly = false } = {},
) {
  const target = resolveCuaSmokeTarget();
  await validateCuaDriverRuntime(pluginRoot, target);
  if (filesOnly) {
    console.log(
      `CUA runtime assets validated (execution skipped for cross-arch build): ${target.platform}-${target.arch}`,
    );
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "zcodium-cua-packaged-"));
  let client;
  try {
    await cp(pluginRoot, root, { recursive: true });
    const mcp = join(root, "dist/mcp");
    await writeFile(
      join(mcp, "native-probe.mjs"),
      `
      globalThis.fetch = () => { throw new Error("Unexpected network"); };
      const { CuaDriver } = await import("@trycua/cua-driver");
      if (typeof CuaDriver.create !== "function") throw new Error("Native SDK unavailable");
      const { captureComputerUseRuntimeFromEnvironment } = await import("./server.js");
      if (await captureComputerUseRuntimeFromEnvironment({}) !== undefined) throw new Error("CUA must default off");
      console.log("native-loaded-default-off");
    `,
    );
    const env = {
      ...process.env,
      NODE_PATH: "",
      ELECTRON_RUN_AS_NODE: "1",
      ZCODE_CUA_DRIVER_EMBEDDED: "",
      ZCODE_CUA_DRIVER_SOCKET: "",
      ZCODE_DATA_BASE_DIR: join(root, "data"),
    };
    const probe = await run(nodeExecutable, [join(mcp, "native-probe.mjs")], {
      cwd: root,
      env,
      timeout: 20000,
    });
    assert.equal(probe.stdout.trim(), "native-loaded-default-off");
    const transport = new StdioClientTransport({
      command: nodeExecutable,
      args: [join(mcp, "server.js")],
      cwd: root,
      env,
      stderr: "pipe",
    });
    client = new Client(
      { name: "zcodium-runtime-smoke", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["js"],
    );
    const result = await client.callTool({
      name: "js",
      arguments: { code: 'nodeRepl.write("shared-host-ready")', title: "检查随包宿主" },
    });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.match(JSON.stringify(result), /shared-host-ready/);
    console.log(
      `CUA native libraries and shared MCP host passed: ${target.platform}-${target.arch}`,
    );
  } finally {
    await client?.close();
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = resolveCuaSmokeTarget();
  const flags = process.argv.slice(2).filter((arg) => arg.startsWith("--"));
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const filesOnly = flags.includes("--files-only");
  let pluginRoot =
    positional[0] ??
    resolve(
      import.meta.dirname,
      `../../packages/desktop/bundled-agents/${target.platform}-${target.arch}/glm/packages/node-repl-host`,
    );
  let nodeExecutable = positional[1];
  if (flags.includes("--packaged")) {
    const platform = target.platform;
    assert.ok(
      platform === "linux" || platform === "win32",
      "Desktop smoke supports Linux and Windows",
    );
    const identity = resolveDesktopProductIdentity();
    // 修复依据：electron-builder 的解包目录名带架构后缀（builder-util 的 getArchSuffix）：
    // 默认架构（linux/win 的 x64）是 `<platform>-unpacked`，其余是 `<platform>-<arch>-unpacked`。
    // 原来写死 `linux-unpacked`，原生 arm64 runner 上跑 `--packaged` 探针会找不到目录。
    const unpackedDir = `${platform}${target.arch === "x64" ? "" : `-${target.arch}`}-unpacked`;
    const appRoot = resolve(
      import.meta.dirname,
      "../../packages/desktop",
      process.env.ZCODE_DESKTOP_DIST_DIR || "dist",
      unpackedDir,
    );
    pluginRoot = join(appRoot, "resources/glm/packages/node-repl-host");
    nodeExecutable = join(
      appRoot,
      platform === "win32" ? `${identity.productName}.exe` : identity.linuxExecutableName,
    );
  }
  await smokeCuaDriverRuntime(pluginRoot, nodeExecutable, { filesOnly });
}
