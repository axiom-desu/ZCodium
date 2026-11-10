import { execFile, fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stageRelease } from "../src/packaging/stage.js";
import {
  coreMessageSchema,
  createStoppedServerStatus,
  type ServerStatus,
} from "../src/contracts.js";
import { createControlServer } from "../src/ipc/controlServer.js";
import { currentServerTarget } from "../src/runtime/manifest.js";
import { ensureServerInstallOwnership } from "../src/runtime/installationOwnership.js";
import { resolveCanonicalServerLayout } from "../src/runtime/paths.js";

const exec = promisify(execFile);
const packageDir = resolve(import.meta.dirname, "..");
const repositoryDir = resolve(packageDir, "../..");
let root: string;
let runtime: string;
let version: string;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "zcode-built-artifacts-"));
  env = {
    ...process.env,
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    APPDATA: join(root, "config"),
    LOCALAPPDATA: join(root, "data"),
    ZCODE_DATA_BASE_DIR: join(root, "data"),
    ZCODE_SERVER_ROOT: join(root, "server"),
    NODE_OPTIONS: "",
    ZCODE_SERVER_SKIP_SERVICE_REGISTRATION: "1",
  };
  delete env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  const { collectRollingAppVersion } = await import(
    pathToFileURL(join(repositoryDir, "scripts/rolling-app-version.mjs")).href
  );
  version = collectRollingAppVersion().appVersion;
  // 必须真实 fresh build，随后把产物与 external 闭包搬到仓库外，禁止借用源码/仓库 node_modules。
  await rm(join(packageDir, "dist"), { recursive: true, force: true });
  await exec("pnpm", ["--filter", "@zcode/server-cli", "build"], {
    cwd: repositoryDir,
    timeout: 120_000,
  });
  const skills = join(root, "skills");
  await mkdir(join(skills, "skills/dynamic-workflows"), { recursive: true });
  await writeFile(join(skills, "README.md"), "fixture skills\n");
  for (const name of ["SKILL.md", "patterns.md", "examples.md"])
    await writeFile(join(skills, "skills/dynamic-workflows", name), "fixture\n");
  // 本片验收 Core 启动而非 Agent 首次消息；Agent fixture 永不执行。
  const agent = join(root, "agent.cjs");
  await writeFile(agent, "throw new Error('Agent fixture must not execute');\n");
  const staged = await stageRelease({
    target: currentServerTarget(),
    appVersion: version,
    distDir: join(packageDir, "dist"),
    agentBundlePath: agent,
    nodeBinaryPath: process.execPath,
    bundledSkillsDir: skills,
    workspaceNodeModulesDir: join(repositoryDir, "node_modules"),
    outputDir: join(root, "release"),
    archive: false,
    componentArchives: false,
    notices: { thirdParty: "test fixture", node: "test fixture", nodeSource: "{}" },
  });
  runtime = join(staged.releaseDir, "runtime");
  await ensureServerInstallOwnership(await resolveCanonicalServerLayout(env.ZCODE_SERVER_ROOT));
}, 120_000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const stagedNode = () => join(runtime, process.platform === "win32" ? "node.exe" : "node");

async function versionOutput(entry: string, node = process.execPath) {
  const { stdout } = await exec(node, [entry, "--version", "--json"], {
    cwd: root,
    env,
    timeout: 15_000,
  });
  return JSON.parse(stdout);
}

function waitForReady(
  child: ChildProcess,
): Promise<{ host: string; port: number; version: string }> {
  return new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error("Built Core did not become ready")), 20_000);
    const cleanup = () => clearTimeout(timeout);
    child.once("exit", (code, signal) => {
      cleanup();
      reject(new Error(`Built Core exited before ready: ${code}/${signal}`));
    });
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("message", (message) => {
      const parsed = coreMessageSchema.safeParse(message);
      if (!parsed.success) return;
      if (parsed.data.type === "fatal") {
        cleanup();
        reject(new Error(parsed.data.message));
      }
      if (parsed.data.type === "ready") {
        cleanup();
        resolveReady(parsed.data);
      }
    });
  });
}

describe("fresh built Server CLI/Core artifacts", () => {
  it("reports the product version in dist and isolated staged external closure", async () => {
    expect(await versionOutput(join(packageDir, "dist/server-cli.js"))).toEqual({
      product: "zcode-server",
      version,
    });
    expect(await versionOutput(join(runtime, "server-cli.js"), stagedNode())).toEqual({
      product: "zcode-server",
      version,
    });
    for (const name of ["yazl", "yauzl"])
      expect(
        JSON.parse(await readFile(join(runtime, "node_modules", name, "package.json"), "utf8"))
          .name,
      ).toBe(name);
  });

  it("waits for starting→ready through the actual bundled CLI and control socket", async () => {
    const layout = await resolveCanonicalServerLayout(env.ZCODE_SERVER_ROOT);
    let status: ServerStatus = { ...createStoppedServerStatus(version), state: "starting" };
    let release!: () => void;
    let polling!: () => void;
    const barrier = new Promise<void>((resolveBarrier) => {
      release = resolveBarrier;
    });
    const secondRequest = new Promise<void>((resolvePolling) => {
      polling = resolvePolling;
    });
    let calls = 0;
    const server = await createControlServer(layout.controlEndpoint, async (request) => {
      expect(request.command).toBe("status");
      if (++calls === 2) {
        polling();
        await barrier;
      }
      return status;
    });
    const command = exec(
      stagedNode(),
      [
        join(runtime, "server-cli.js"),
        "serve",
        "--daemon",
        "--json",
        "--server-root",
        layout.serverRoot,
      ],
      {
        cwd: root,
        env,
        timeout: 15_000,
      },
    );
    try {
      await Promise.race([
        secondRequest,
        command.then(() => {
          throw new Error("Built CLI returned starting before barrier");
        }),
      ]);
      status = {
        ...status,
        state: "ready",
        pid: process.pid,
        generation: 1,
        host: "127.0.0.1",
        port: 32123,
      };
      release();
      expect(JSON.parse((await command).stdout)).toMatchObject({
        state: "ready",
        port: 32123,
        version,
      });
    } finally {
      release();
      await server.close();
      await command.catch(() => undefined);
    }
  });

  it("runs the external CJS zip libraries and their transitive closure outside the repository", async () => {
    const script = `
      import { ZipFile } from 'yazl';
      import { open } from 'yauzl';
      import { createWriteStream } from 'node:fs';
      import { pipeline } from 'node:stream/promises';
      const zip = new ZipFile();
      const written = pipeline(zip.outputStream, createWriteStream('fixture.zip'));
      zip.addBuffer(Buffer.from('isolated zip round trip'), 'entry.txt');
      zip.end();
      await written;
      const archive = await new Promise((resolve, reject) =>
        open('fixture.zip', { lazyEntries: true }, (error, value) => error ? reject(error) : resolve(value)));
      const entry = await new Promise((resolve, reject) => {
        archive.once('error', reject);
        archive.once('entry', resolve);
        archive.readEntry();
      });
      const stream = await new Promise((resolve, reject) =>
        archive.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value)));
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      archive.close();
      process.stdout.write(JSON.stringify({ name: entry.fileName, text: Buffer.concat(chunks).toString() }));
    `;
    const { stdout } = await exec(stagedNode(), ["--input-type=module", "-e", script], {
      cwd: runtime,
      env,
      timeout: 15_000,
    });
    expect(JSON.parse(stdout)).toEqual({ name: "entry.txt", text: "isolated zip round trip" });
  });

  it("starts the actual staged Core and serves authenticated loopback info", async () => {
    const child = fork(join(runtime, "server-core.js"), ["7"], {
      cwd: root,
      env,
      execPath: stagedNode(),
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let diagnostics = "";
    child.stdout?.on("data", (chunk) => {
      diagnostics += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      diagnostics += chunk;
    });
    const exited = new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
    try {
      const ready = await waitForReady(child);
      expect(ready.version).toBe(version);
      expect(ready.host).toBe("127.0.0.1");
      expect(ready.port).toBeGreaterThan(0);
      const token = (await readFile(join(root, "server/run/ingress-token"), "utf8")).trim();
      const response = await fetch(`http://${ready.host}:${ready.port}/api/server-info`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        version,
        authRequired: true,
        compatibility: { productVersion: version, minCompatibleVersion: version },
      });
      child.send({ command: "shutdown" });
      expect(await exited).toBe(0);
    } catch (error) {
      throw new Error(`${String(error)}\n${diagnostics}`, { cause: error });
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited;
    }
  }, 30_000);
});
