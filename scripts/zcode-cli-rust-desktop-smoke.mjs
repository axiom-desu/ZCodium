#!/usr/bin/env node
// M8 真实 Electron 最小 E2E。
//
// 这一条链路只做一件事：用本轮构建的桌面产物启动真实 App，在隔离 HOME/userData/sessionData/
// XDG/DATA_BASE 下完成数据库 ready、创建会话、受控模型文本；时间允许再验证工具与切回 TS 恢复。
// 本地模型唯一 owner 是 scripts/lib/zcode-cli-rust-interop-fixture.mjs；不伪造 ACK，不访问外网。
// 边界与事件顺序见 .agents/specs/cli-rust-m8-e2e.md。
import { execFile } from "node:child_process";
import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { modelServer, prepareHome } from "./lib/zcode-cli-rust-interop-fixture.mjs";
import { runDesktopE2EBuild } from "./lib/zcode-cli-rust-desktop-build.mjs";
import {
  createDesktopE2EEnvironment,
  resolveRepoRoot,
  summarizeEnvironment,
} from "./lib/zcode-cli-rust-desktop-env.mjs";
import { startFailClosedProxy } from "./lib/zcode-cli-rust-desktop-network.mjs";
import {
  closeDesktopApp,
  launchDesktopApp,
  readTimelineText,
  resolveElectronBinary,
  sendPrompt,
  waitForDatabaseReady,
  waitForTimelineText,
} from "./lib/zcode-cli-rust-desktop-app.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolveRepoRoot();
const desktopRoot = resolve(repoRoot, "packages/desktop");

function parseArgs(argv) {
  const options = {
    build: true,
    keep: false,
    runtime: "zcode-cli-rust",
    restartRuntime: "ts",
    skipRestart: false,
    skipTool: false,
    preferDevRust: true,
    timeoutMs: 180_000,
    evidencePath: process.env.ZCODE_M8_E2E_EVIDENCE?.trim() || null,
  };
  for (const arg of argv) {
    if (arg === "--no-build") options.build = false;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--skip-restart") options.skipRestart = true;
    else if (arg === "--skip-tool") options.skipTool = true;
    else if (arg === "--no-prefer-dev-rust") options.preferDevRust = false;
    else if (arg.startsWith("--runtime=")) options.runtime = arg.slice("--runtime=".length);
    else if (arg.startsWith("--restart-runtime="))
      options.restartRuntime = arg.slice("--restart-runtime=".length);
    else if (arg.startsWith("--timeout-ms=")) options.timeoutMs = Number(arg.slice(13));
    else if (arg.startsWith("--evidence=")) options.evidencePath = arg.slice("--evidence=".length);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  process.stdout.write(`M8 desktop E2E

Usage: node scripts/zcode-cli-rust-desktop-smoke.mjs [options]

  --no-build            复用现有 out/，不重新构建本轮桌面产物
  --keep                保留临时根目录（默认 finally 清理）
  --runtime=<id>        首次启动的 ZCODE_AGENT_SERVER_RUNTIME（默认 zcode-cli-rust）
  --restart-runtime=<id> 重启验证使用的 runtime（默认 ts）
  --skip-restart        跳过切回 TS 的恢复验证
  --skip-tool           跳过文件工具验证
  --no-prefer-dev-rust  不临时移开陈旧 bundled-agents Rust 产物（默认移开以保证用 fresh Cargo target）
  --timeout-ms=<n>      单步等待上限（默认 180000）
  --evidence=<path>     额外落盘 evidence JSON
`);
}

/** 在 Linux/macOS 上扫描真实 agent 进程，作为 runtime 选择的直接证据。 */
async function scanAgentProcesses() {
  if (process.platform === "win32") return { supported: false, matches: [] };
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="], {
      maxBuffer: 8 * 1024 * 1024,
    });
    const matches = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const spaceIndex = trimmed.indexOf(" ");
      if (spaceIndex < 0) continue;
      const pid = Number(trimmed.slice(0, spaceIndex));
      const args = trimmed.slice(spaceIndex + 1);
      if (/zcode-cli-rust/.test(args) && !/smoke|ps -eo/.test(args)) {
        matches.push({ pid, kind: "rust", args });
      } else if (/zcode\.cjs|zcode-agent/.test(args) && /app-server/.test(args)) {
        matches.push({ pid, kind: "node", args });
      }
    }
    return { supported: true, matches };
  } catch (error) {
    return { supported: false, matches: [], error: String(error) };
  }
}

/** 第一次会话：创建 + 模型文本；返回证据。 */
async function runConversationFlow({ page, runId, evidence, options }) {
  const unique = `m8-e2e-${runId}`;
  await sendPrompt(page, unique);
  await waitForTimelineText(page, `answer: ${unique}`, { timeoutMs: options.timeoutMs });
  evidence.conversation.created = true;
  evidence.conversation.prompt = unique;
  evidence.conversation.assistantTextVerified = true;

  if (!options.skipTool) {
    try {
      await sendPrompt(page, "use tool");
      const deadline = Date.now() + options.timeoutMs;
      let toolSeen = false;
      let lastText = "";
      while (Date.now() < deadline) {
        lastText = await readTimelineText(page);
        // fixture 模型对 `use tool` 返回 Read 调用，工具结果回灌后回复 `tool done`；
        // V4 时间线用通用 v4-row-* 渲染工具行，不保证旧 chat-tool-call-block testid。
        if (/tool done/i.test(lastText) || /note\.txt/i.test(lastText)) {
          toolSeen = true;
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
      evidence.tool = { requested: true, toolCallVisible: toolSeen };
      if (!toolSeen) {
        evidence.tool.lastTimelineText = lastText.slice(-500);
        evidence.blockers.push("tool call did not become visible for 'use tool'");
      }
    } catch (error) {
      evidence.tool = { requested: true, toolCallVisible: false, error: String(error) };
      evidence.blockers.push(`tool flow failed: ${String(error)}`);
    }
  }
  return unique;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }
  if (!existsSync(desktopRoot)) throw new Error(`desktop package not found at ${desktopRoot}`);
  process.chdir(repoRoot);

  const evidence = {
    spec: ".agents/specs/cli-rust-m8-e2e.md",
    repoRoot,
    runId: null,
    environment: null,
    build: null,
    database: null,
    conversation: { created: false, assistantTextVerified: false },
    tool: null,
    runtime: { first: options.runtime, processes: [], selectorHonored: null },
    restart: null,
    network: { rendererBlocked: [], mainBlocked: [], proxyDenied: [], limitations: [] },
    blockers: [],
    ok: false,
  };

  let model = null;
  let proxy = null;
  let environment = null;
  let activeApp = null;
  let hiddenStagedRust = null;

  try {
    if (options.build) {
      process.stdout.write("[m8] building desktop (tsup + vite) ...\n");
      evidence.build = await runDesktopE2EBuild({ cwd: desktopRoot });
      process.stdout.write(`[m8] build done in ${evidence.build.durationMs}ms\n`);
    } else {
      process.stdout.write("[m8] --no-build: reusing existing out/\n");
      evidence.build = { reused: true, cwd: desktopRoot };
    }

    const root = await mkdtempRoot();
    model = await modelServer({ root });
    const fixtureEnv = await prepareHome(root, model.baseUrl);

    environment = await createDesktopE2EEnvironment({
      fixtureEnv,
      runtime: options.runtime,
      dataRoot: root,
    });
    const runId = environment.runId;
    evidence.runId = runId;
    evidence.environment = summarizeEnvironment(environment.env);
    if (evidence.environment.leaks.length) {
      evidence.blockers.push(
        `inherited sensitive environment keys: ${evidence.environment.leaks.join(", ")}`,
      );
    }

    // 预置 Read 工具目标：conversation backing workspace 与一个项目 workspace。
    await seedReadToolWorkspace(environment);
    // 桌面 Host 会把 agent 的 personal provider 路径指向 dataBase 下的 app config；
    // 必须把 fixture provider 写到该唯一路径，renderer 与 CLI 才会看到同一个可控模型。
    await seedDesktopProviderConfig(environment, fixtureEnv);

    // 本仓被 gitignore 的 bundled-agents/<platform>/rust 可能是旧构建（不支持 --prepare-storage，
    // 只会在 stdout 打印版本号，被 native transport 当成非 JSON 帧）。它会让 dev 误用旧产物；
    // 这里仅在它确实不支持存储准备时临时移开，保证测试命中的是 fresh Cargo target，finally 恢复。
    if (options.preferDevRust) {
      hiddenStagedRust = await hideStaleStagedRust(desktopRoot);
      if (hiddenStagedRust) evidence.runtime.stagedRustHidden = hiddenStagedRust.hiddenPath;
    }

    proxy = await startFailClosedProxy({ label: runId });
    environment.env.ZCODE_HTTP_PROXY = proxy.url;
    environment.env.ZCODE_NO_PROXY = "127.0.0.1,localhost";
    environment.env.HTTP_PROXY = proxy.url;
    environment.env.HTTPS_PROXY = proxy.url;
    environment.env.ALL_PROXY = proxy.url;
    environment.env.NO_PROXY = "127.0.0.1,localhost";

    const electronBinary = resolveElectronBinary(desktopRoot);

    // 第一次：显式 Rust runtime。
    activeApp = await launchDesktopApp({
      electronBinary,
      desktopRoot,
      env: environment.env,
      proxyUrl: proxy.url,
    });
    await waitForDatabaseReady(activeApp.page, { timeoutMs: options.timeoutMs });
    evidence.database = { phase: "ready" };

    const processes = await scanAgentProcesses();
    evidence.runtime.processes = processes.matches;
    evidence.runtime.selectorHonored =
      options.runtime === "zcode-cli-rust"
        ? processes.matches.some((entry) => entry.kind === "rust")
        : !processes.matches.some((entry) => entry.kind === "rust");
    if (options.runtime === "zcode-cli-rust" && !evidence.runtime.selectorHonored) {
      evidence.blockers.push(
        `ZCODE_AGENT_SERVER_RUNTIME=${options.runtime} did not launch a zcode-cli-rust process; ` +
          `observed=${JSON.stringify(processes.matches)}`,
      );
    }

    await runConversationFlow({ page: activeApp.page, runId, evidence, options });

    // 第二次：切回 TS，验证同一会话可读（唯一库 owner 由 CLI 持有）。
    if (!options.skipRestart) {
      evidence.restart = { runtime: options.restartRuntime, restored: false };
      await closeDesktopApp(activeApp.app);
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
      const restartEnv = { ...environment.env, ZCODE_AGENT_SERVER_RUNTIME: options.restartRuntime };
      const restarted = await launchDesktopApp({
        electronBinary,
        desktopRoot,
        env: restartEnv,
        proxyUrl: proxy.url,
      });
      activeApp = restarted;
      await waitForDatabaseReady(restarted.page, { timeoutMs: options.timeoutMs });
      try {
        await waitForTimelineText(restarted.page, `answer: ${evidence.conversation.prompt}`, {
          timeoutMs: options.timeoutMs,
        });
        evidence.restart.restored = true;
      } catch (error) {
        // 自动恢复失败时尝试点开最近任务，区分“未恢复”与“UI 未自动聚焦”。
        const taskItem = restarted.page.locator('[data-testid^="task-item"]').first();
        if ((await taskItem.count()) > 0) {
          await taskItem.click().catch(() => {});
          try {
            await waitForTimelineText(restarted.page, `answer: ${evidence.conversation.prompt}`, {
              timeoutMs: 30_000,
            });
            evidence.restart.restored = true;
          } catch {
            evidence.restart.error = String(error);
          }
        } else {
          evidence.restart.error = String(error);
        }
        if (!evidence.restart.restored) {
          const text = await readTimelineText(restarted.page);
          evidence.restart.lastTimelineText = text.slice(-400);
          evidence.blockers.push(`restart with ${options.restartRuntime} did not restore session`);
        }
      }
    }

    evidence.network.rendererBlocked = activeApp.rendererBlocked.slice(0, 50);
    evidence.network.proxyDenied = proxy.denied.slice(0, 50);
    evidence.network.mainBlocked = [...(await activeApp.blockedMainUrls().catch(() => []))].slice(
      0,
      50,
    );
    evidence.network.limitations.push(
      "Node-side direct egress from main/host cannot be fully guaranteed without product changes; " +
        "Chromium egress is fail-closed via host-resolver-rules + proxy + webRequest.",
    );
    evidence.model = {
      requestCount: model.requests.length,
      userTexts: model.requests
        .map((request) => request.messages?.at(-1)?.content)
        .map((content) => (typeof content === "string" ? content : "[parts]"))
        .slice(-6),
    };
    evidence.ok = evidence.blockers.length === 0;
  } catch (error) {
    evidence.blockers.push(String(error instanceof Error ? (error.stack ?? error.message) : error));
  } finally {
    await closeDesktopApp(activeApp?.app).catch(() => {});
    await forceKillAppTree(activeApp).catch(() => {});
    if (model) await model.close().catch(() => {});
    if (proxy) await proxy.close().catch(() => {});
    if (!options.keep && environment) {
      await rm(environment.root, { recursive: true, force: true }).catch(() => {});
    } else if (options.keep && environment) {
      process.stdout.write(`[m8] kept temp root: ${environment.root}\n`);
    }
    await restoreStagedRust(hiddenStagedRust).catch(() => {});
  }

  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  process.stdout.write(serialized);
  if (options.evidencePath) {
    await mkdir(resolve(options.evidencePath, ".."), { recursive: true }).catch(() => {});
    await writeFile(options.evidencePath, serialized).catch(() => {});
  }
  return evidence.ok ? 0 : 1;
}

async function mkdtempRoot() {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  return mkdtemp(join(tmpdir(), "zcode-m8-desktop-"));
}

async function seedDesktopProviderConfig(environment, fixtureEnv) {
  const appConfigDir = join(environment.dataBase, ".zcodium-exp", "v2");
  await mkdir(appConfigDir, { recursive: true });
  const personalTarget = join(appConfigDir, "provider_config.json");
  await copyFile(fixtureEnv.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, personalTarget);
  environment.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personalTarget;
}

async function seedReadToolWorkspace(environment) {
  const workspaceDirs = [
    join(environment.dataBase, ".zcodium-exp", "workspace", "default"),
    join(environment.root, "workspace"),
  ];
  await Promise.all(
    workspaceDirs.map(async (dir) => {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "note.txt"), "m8 read tool fixture\n");
    }),
  );
}

async function hideStaleStagedRust(root) {
  const platformKey = `${process.platform}-${process.arch}`;
  const binaryName = process.platform === "win32" ? "zcode-cli-rust.exe" : "zcode-cli-rust";
  const staged = resolve(root, "bundled-agents", platformKey, "rust", binaryName);
  if (!existsSync(staged)) return null;
  // 只隐藏确实缺少存储准备能力的旧产物，fresh 产物原样保留。
  let supports = false;
  try {
    const { stdout, stderr } = await execFileAsync(staged, ["app-server", "--help"], {
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    supports = `${stdout}\n${stderr}`.includes("--prepare-storage");
  } catch {
    supports = false;
  }
  if (supports) return null;
  const hiddenPath = `${staged}.m8-stale-hidden`;
  await rename(staged, hiddenPath);
  process.stdout.write(`[m8] hid stale staged Rust binary (no --prepare-storage): ${staged}\n`);
  return { staged, hiddenPath };
}

async function restoreStagedRust(hidden) {
  if (!hidden) return;
  if (existsSync(hidden.hiddenPath) && !existsSync(hidden.staged)) {
    await rename(hidden.hiddenPath, hidden.staged);
  }
}

function forceKillAppTree(appHandle) {
  let pid;
  try {
    pid = appHandle?.app?.process?.()?.pid;
  } catch {
    return Promise.resolve();
  }
  if (!pid) return Promise.resolve();
  try {
    if (process.platform === "win32") appHandle.app.process().kill("SIGKILL");
    else process.kill(-pid, "SIGKILL");
  } catch {
    try {
      appHandle.app.process().kill("SIGKILL");
    } catch {
      // 进程已退出。
    }
  }
  return Promise.resolve();
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
