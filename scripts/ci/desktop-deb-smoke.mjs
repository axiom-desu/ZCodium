#!/usr/bin/env node
// Linux deb 解包启动验收：只验证本机真实安装包内容，不执行 dpkg -i、不触碰用户数据。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative, sep } from "node:path";
import { collectRollingAppVersion } from "../rolling-app-version.mjs";
import { contentText, modelServer, prepareHome } from "../lib/zcode-cli-rust-interop-fixture.mjs";
import {
  createDesktopE2EEnvironment,
  resolveRepoRoot,
  summarizeEnvironment,
} from "../lib/zcode-cli-rust-desktop-env.mjs";
import { startFailClosedProxy } from "../lib/zcode-cli-rust-desktop-network.mjs";
import {
  closeDesktopApp,
  launchDesktopApp,
  readTimelineText,
  sendPrompt,
  waitForDatabaseReady,
  waitForTimelineText,
} from "../lib/zcode-cli-rust-desktop-app.mjs";
import { desktopProductIdentities } from "../../packages/desktop/scripts/desktop-product-identity.mjs";
import {
  parseDebSmokeArgs,
  verifyDebIdentity,
  selectPackagedRuntimeProcesses,
  readOwnDescendantCmdlines,
  appProcessId,
} from "../lib/desktop-deb-smoke.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolveRepoRoot();
const timeoutMs = 180_000;
const noteMarker = "DEB_SMOKE_READ_NOTE_7f31";

async function command(file, args, opts = {}) {
  return (await execFileAsync(file, args, { maxBuffer: 4 * 1024 * 1024, ...opts })).stdout;
}
async function findExecutable(root, name) {
  const lines = (await command("find", [root, "-type", "f", "-name", name])).trim().split("\n");
  const hits = lines.filter(Boolean);
  if (hits.length !== 1)
    throw new Error(`expected one packaged executable ${name}, found ${hits.length}`);
  return resolve(hits[0]);
}
async function forceKillTree(pid, expectedCmdline) {
  if (!pid || !expectedCmdline) return;
  try {
    if (!(await readFile(`/proc/${pid}/cmdline`)).equals(expectedCmdline)) return;
  } catch {
    return;
  }
  const descendants = await readOwnDescendantCmdlines(pid).catch(() => []);
  for (const item of descendants.reverse())
    try {
      process.kill(item.pid, "SIGTERM");
    } catch {}
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
}

async function main() {
  const options = parseDebSmokeArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/ci/desktop-deb-smoke.mjs --deb=<abs> --flavor=production|preview --evidence=<abs> [--keep]\n",
    );
    return 0;
  }
  if (process.platform !== "linux") throw new Error("desktop-deb-smoke requires Linux");
  const evidence = {
    flavor: options.flavor,
    deb: options.deb,
    debSha256: null,
    appPath: null,
    runtime: null,
    steps: [],
    errors: [],
    screenshot: null,
    ok: false,
  };
  let root;
  let environment;
  let appHandle;
  let proxy;
  let model;
  try {
    const hash = (await command("sha256sum", [options.deb])).split(/\s+/)[0];
    evidence.debSha256 = hash;
    const fields = {};
    for (const field of ["Package", "Version", "Architecture"])
      fields[field] = await command("dpkg-deb", ["-f", options.deb, field]);
    evidence.expectedVersion = collectRollingAppVersion().appVersion;
    evidence.package = verifyDebIdentity(
      fields,
      options.flavor,
      process.arch,
      evidence.expectedVersion,
    );
    evidence.steps.push("dpkg-deb identity verified");
    root = await mkdtemp(join(tmpdir(), "zcode-deb-smoke-"));
    const unpack = join(root, "unpacked");
    await mkdir(unpack);
    await command("dpkg-deb", ["-x", options.deb, unpack]);
    evidence.steps.push("deb extracted");
    const exe = desktopProductIdentities[options.flavor].linuxExecutableName;
    const appPath = await findExecutable(unpack, exe);
    evidence.appPath = appPath;
    const rel = relative(unpack, appPath);
    if (rel.startsWith(`..${sep}`) || rel === "..")
      throw new Error("packaged executable escaped extraction root");

    model = await modelServer({ root });
    const fixtureEnv = await prepareHome(root, model.baseUrl);
    environment = await createDesktopE2EEnvironment({
      fixtureEnv,
      dataRoot: join(root, "isolated"),
    });
    // deb smoke 不给 runtime override，也不依赖构建期开关的 E2E store bridge。
    for (const key of [
      "ZCODE_AGENT_SERVER_RUNTIME",
      "ZCODE_RUNTIME_ENV",
      "ZCODE_CLI_PATH",
      "ZCODE_AGENT_SERVER_PATH",
      "VITE_ZCODE_E2E_STORE_BRIDGE",
      "ZCODE_DESKTOP_APPLICATION_NAME",
    ])
      delete environment.env[key];
    const workspace = join(environment.dataBase, ".zcodium-exp", "workspace", "default");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "note.txt"), `${noteMarker}\n`);
    // 与既有 smoke 的 seed 规则一致：个人 provider 配置归属当前 appConfigDir。
    const providerDir = join(environment.dataBase, ".zcodium-exp", "v2");
    await mkdir(providerDir, { recursive: true });
    const providerPath = join(providerDir, "provider_config.json");
    const original = fixtureEnv.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
    await copyFile(original, providerPath);
    environment.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = providerPath;
    proxy = await startFailClosedProxy({ label: "desktop-deb-smoke" });
    Object.assign(environment.env, {
      ZCODE_HTTP_PROXY: proxy.url,
      ZCODE_NO_PROXY: "127.0.0.1,localhost",
      HTTP_PROXY: proxy.url,
      HTTPS_PROXY: proxy.url,
      ALL_PROXY: proxy.url,
      NO_PROXY: "127.0.0.1,localhost",
    });
    appHandle = await launchDesktopApp({
      electronBinary: appPath,
      desktopRoot: repoRoot,
      env: environment.env,
      proxyUrl: proxy.url,
      packaged: true,
    });
    const packaged = await appHandle.app.evaluate(({ app }) => ({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      version: app.getVersion(),
      name: app.getName(),
    }));
    if (
      !packaged.isPackaged ||
      !resolve(packaged.resourcesPath).startsWith(`${unpack}${sep}`) ||
      !resolve(packaged.appPath).startsWith(`${unpack}${sep}`)
    )
      throw new Error(`packaged path assertion failed: ${JSON.stringify(packaged)}`);
    if (packaged.version !== evidence.expectedVersion)
      throw new Error(`payload version mismatch: ${packaged.version}`);
    if (packaged.name !== desktopProductIdentities[options.flavor].productName)
      throw new Error(`payload product mismatch: ${packaged.name}`);
    evidence.packaged = packaged;
    evidence.steps.push("real packaged Electron path verified");
    evidence.network = {
      rendererBlocked: appHandle.rendererBlocked,
      mainBlocked: await appHandle.blockedMainUrls(),
      proxyBlocked: proxy.denied,
      directNodeEgress:
        "not fully guaranteed: Chromium guards and fail-closed proxy do not constrain arbitrary Node direct sockets",
    };
    evidence.environment = { ...summarizeEnvironment(environment.env), runtimeOverride: null };
    if (
      evidence.environment.leaks.length ||
      environment.env.ZCODE_AGENT_SERVER_RUNTIME ||
      environment.env.ZCODE_RUNTIME_ENV ||
      environment.env.ZCODE_CLI_PATH ||
      environment.env.ZCODE_AGENT_SERVER_PATH
    )
      throw new Error(`final environment audit failed: ${JSON.stringify(evidence.environment)}`);
    await waitForDatabaseReady(appHandle.page, { timeoutMs });
    evidence.steps.push("database/UI ready");
    const prompt = `deb-smoke-${Date.now()}`;
    await sendPrompt(appHandle.page, prompt);
    await waitForTimelineText(appHandle.page, `answer: ${prompt}`, { timeoutMs });
    evidence.steps.push("real DOM prompt answered");
    await sendPrompt(appHandle.page, "use tool");
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const timeline = await readTimelineText(appHandle.page);
      const toolDone = timeline.includes("tool done");
      const toolReply = model.requests.some((request) =>
        request.messages?.some(
          (message) => message.role === "tool" && contentText(message.content).includes(noteMarker),
        ),
      );
      if (toolDone && toolReply) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await waitForTimelineText(appHandle.page, "tool done", { timeoutMs: 10_000 });
    if (
      !model.requests.some((request) =>
        request.messages?.some(
          (message) => message.role === "tool" && contentText(message.content).includes(noteMarker),
        ),
      )
    )
      throw new Error("model did not receive role:tool content containing fixture marker");
    evidence.steps.push("UI tool done and strict model role:tool marker replay verified");
    const pid = appProcessId(appHandle.app);
    const processes = await readOwnDescendantCmdlines(pid);
    evidence.observedProcesses = processes;
    const runtimeMatches = selectPackagedRuntimeProcesses(
      processes,
      pid,
      packaged.resourcesPath,
      options.flavor,
    );
    if (!runtimeMatches.length)
      throw new Error(`no ${options.flavor} runtime at expected packaged path in App PID subtree`);
    if (options.flavor === "production") {
      // argv 已被 TS CLI title 覆盖时，额外机械验证 bundle 存在；cwd 已固定在包目录。
      const bundle = join(packaged.resourcesPath, "glm", "zcode.cjs");
      await command("test", ["-s", bundle]);
      evidence.tsBundle = bundle;
    }
    evidence.runtime = runtimeMatches;
    const screenshot = `${options.evidence}.png`;
    await mkdir(dirname(screenshot), { recursive: true });
    await appHandle.page.screenshot({ path: screenshot });
    evidence.screenshot = screenshot;
    if (options.keep) await copyFile(screenshot, join(root, "app-window.png"));
    await closeDesktopApp(appHandle.app);
    appHandle = null;
    // 同一隔离 HOME/data 重启，恢复相同会话（必要时点 task-item）。
    const restarted = await launchDesktopApp({
      electronBinary: appPath,
      desktopRoot: repoRoot,
      env: environment.env,
      proxyUrl: proxy.url,
      packaged: true,
    });
    appHandle = restarted;
    await waitForDatabaseReady(restarted.page, { timeoutMs });
    try {
      await waitForTimelineText(restarted.page, `answer: ${prompt}`, { timeoutMs: 30_000 });
    } catch {
      const task = restarted.page.locator('[data-testid^="task-item"]').first();
      if (!(await task.count()))
        throw new Error("restart did not restore session and no task item exists");
      await task.click();
      await waitForTimelineText(restarted.page, `answer: ${prompt}`, { timeoutMs: 30_000 });
    }
    evidence.steps.push("same isolated HOME restart restored conversation");
    const followup = `after-restart-${Date.now()}`;
    await sendPrompt(restarted.page, followup);
    await waitForTimelineText(restarted.page, `answer: ${followup}`, { timeoutMs });
    const resumedRequest = model.requests.at(-1);
    if (
      !resumedRequest?.messages?.some(
        (message) => message.role === "user" && contentText(message.content) === prompt,
      )
    ) {
      throw new Error("restarted runtime answered without the persisted original user turn");
    }
    evidence.steps.push("post-restart followup answered with persisted conversation history");
    evidence.ok = true;
  } catch (error) {
    evidence.errors.push(String(error?.stack ?? error));
  } finally {
    if (appHandle) {
      const pid = appProcessId(appHandle.app);
      const expectedCmdline = pid ? await readFile(`/proc/${pid}/cmdline`).catch(() => null) : null;
      const beforeClose = pid ? await readOwnDescendantCmdlines(pid).catch(() => []) : [];
      evidence.network ??= {};
      evidence.network.rendererBlocked = appHandle.rendererBlocked;
      evidence.network.mainBlocked = await appHandle.blockedMainUrls().catch(() => []);
      evidence.mainErrors = appHandle.errors;
      evidence.errors.push(...appHandle.errors.map((error) => `app: ${error}`));
      if (!evidence.screenshot) {
        try {
          const screenshot = `${options.evidence}.png`;
          await mkdir(dirname(screenshot), { recursive: true });
          await appHandle.page.screenshot({ path: screenshot });
          evidence.screenshot = screenshot;
        } catch (error) {
          evidence.errors.push(`failure screenshot: ${error}`);
        }
      }
      await closeDesktopApp(appHandle.app);
      for (const child of beforeClose.reverse())
        try {
          // 连接关闭后只清理仍保持同一 argv 的测试后代，不向复用 PID 的其他进程发信号。
          const current = (await readFile(`/proc/${child.pid}/cmdline`))
            .toString()
            .replaceAll("\0", " ")
            .trim();
          if (current === child.cmdline) process.kill(child.pid, "SIGTERM");
        } catch {}
      await forceKillTree(pid, expectedCmdline);
    }
    if (proxy) await proxy.close().catch((e) => evidence.errors.push(`proxy close: ${e}`));
    if (model) await model.close().catch((e) => evidence.errors.push(`model close: ${e}`));
    if (root && !options.keep)
      await rm(root, { recursive: true, force: true }).catch((e) =>
        evidence.errors.push(`temp cleanup: ${e}`),
      );
    else if (root) evidence.keptRoot = root;
    await mkdir(dirname(options.evidence), { recursive: true });
    if (evidence.errors.length) evidence.ok = false;
    await writeFile(options.evidence, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  return evidence.ok ? 0 : 1;
}
main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exit(1);
  });
