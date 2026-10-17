import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import {
  consumeTopLevelCli,
  getDesktopUserArgv,
  resolveCliPlan,
} from "../../packages/desktop/src/main/cliDispatch.ts";

const desktopRoot = resolve(import.meta.dirname, "../../packages/desktop");
test("consumes only the first top-level --cli and preserves remaining argument values", () => {
  assert.deepEqual(consumeTopLevelCli(["--cli", "", "--", "help", "-p", "tui", "--cli"]), {
    isCli: true,
    argv: ["", "--", "help", "-p", "tui", "--cli"],
  });
  assert.deepEqual(consumeTopLevelCli(["-p", "prompt --cli", "--cli"]), {
    isCli: false,
    argv: ["-p", "prompt --cli", "--cli"],
  });
  assert.deepEqual(getDesktopUserArgv(["/checkout/packages/desktop", "--cli", "--help"], true), [
    "--cli",
    "--help",
  ]);
  assert.deepEqual(getDesktopUserArgv(["--cli", "--help"], false), ["--cli", "--help"]);
});

test("selects runtime defaults and explicit overrides, failing closed on unknown or absent artifacts", () => {
  const base = {
    argv: ["", "--", "help"],
    cwd: "/work",
    env: {},
    platform: "linux",
    bootstrapDir: `${desktopRoot}/out/main`,
  };
  const ts = resolveCliPlan({ ...base, isPackaged: false, productFlavor: "production" });
  assert.equal(ts.executable, process.execPath);
  assert.deepEqual(ts.args.slice(2), ["", "--", "help"]);
  assert.equal(ts.cwd, "/work");
  assert.equal(ts.env.ELECTRON_RUN_AS_NODE, "1");
  const rust = resolveCliPlan({
    ...base,
    isPackaged: true,
    resourcesPath: "/app/resources",
    productFlavor: "preview",
  });
  assert.equal(rust.runtime, "zcode-cli-rust");
  assert.equal(rust.executable, "/app/resources/rust/zcode-cli-rust");
  assert.equal(
    resolveCliPlan({
      ...base,
      env: { ZCODE_AGENT_SERVER_RUNTIME: "ts" },
      isPackaged: true,
      resourcesPath: "/app/resources",
      productFlavor: "preview",
    }).runtime,
    "ts",
  );
  assert.equal(
    resolveCliPlan({
      ...base,
      env: { ZCODE_AGENT_SERVER_RUNTIME: "  TS  " },
      isPackaged: true,
      resourcesPath: "/app/resources",
      productFlavor: "preview",
    }).runtime,
    "ts",
  );
  assert.equal(
    resolveCliPlan({
      ...base,
      env: { ZCODE_AGENT_SERVER_RUNTIME: "   " },
      isPackaged: true,
      resourcesPath: "/app/resources",
      productFlavor: "preview",
    }).runtime,
    "zcode-cli-rust",
  );
  assert.throws(
    () =>
      resolveCliPlan({
        ...base,
        env: { ZCODE_AGENT_SERVER_RUNTIME: "other" },
        isPackaged: false,
        productFlavor: "production",
      }),
    /未知/,
  );
  assert.equal(
    resolveCliPlan({ ...base, isPackaged: false, productFlavor: "production" }).runtime,
    "ts",
  );
  assert.equal(
    resolveCliPlan({
      ...base,
      isPackaged: true,
      resourcesPath: "/app/resources",
      productFlavor: "preview",
    }).executable,
    "/app/resources/rust/zcode-cli-rust",
  );
});

test("real Electron bootstrap runs a stub CLI headlessly without importing GUI", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zcode-cli-bootstrap-"));
  try {
    const mainDir = join(temp, "app", "out", "main");
    const platformKey = `${process.platform}-${process.arch}`;
    const agentDir = join(temp, "app", "bundled-agents", platformKey, "glm");
    await mkdir(mainDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const guiFlag = join(temp, "gui-imported");
    const cliOutput = join(temp, "cli-output");
    await writeFile(
      join(mainDir, "gui.js"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(guiFlag)}, "imported");`,
    );
    await writeFile(
      join(agentDir, "zcode.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(cliOutput)}, process.argv.slice(2).join("|"));`,
    );
    const bootstrapEntry = resolve(desktopRoot, "src/main/bootstrap.ts");
    await build({
      entryPoints: [bootstrapEntry],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      outfile: join(mainDir, "index.js"),
      external: ["./gui.js"],
      define: { __ZCODE_PRODUCT_FLAVOR__: JSON.stringify("production") },
    });
    await writeFile(
      join(temp, "app", "package.json"),
      JSON.stringify({ type: "module", main: "out/main/index.js" }),
    );
    const electron = resolve(desktopRoot, "../../node_modules/.bin/electron");
    const env = {
      ...process.env,
      DISPLAY: "",
      WAYLAND_DISPLAY: "",
      ELECTRON_DISABLE_GPU: "1",
      ELECTRON_DISABLE_SANDBOX: "1",
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ZCODE_AGENT_SERVER_RUNTIME;
    const result = await new Promise((resolveResult, reject) => {
      // CI 的 SUID/userns 策略会在 JS bootstrap 前终止 Electron；仅隔离 probe 显式禁用沙箱。
      const child = spawn(electron, [join(temp, "app"), "--cli", "--help"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
      child.stdout.setEncoding("utf8").on("data", (data) => {
        stdout += data;
      });
      child.stderr.setEncoding("utf8").on("data", (data) => {
        stderr += data;
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        resolveResult({ code, signal, stdout, stderr });
      });
    });
    assert.equal(result.code, 0, `${result.stderr} ${result.stdout}`);
    assert.equal(await readFile(cliOutput, "utf8"), "--help");
    await assert.rejects(readFile(guiFlag));
    assert.doesNotMatch(result.stdout, /GUI/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("entrypoint remains light and routes GUI through a dynamic GUI chunk", async () => {
  const bootstrap = await readFile(resolve(desktopRoot, "src/main/bootstrap.ts"), "utf8");
  const config = await readFile(resolve(desktopRoot, "tsup.config.ts"), "utf8");
  assert.match(bootstrap, /await import\("\.\/gui\.js"\)/);
  assert.doesNotMatch(bootstrap, /from ["']@zcode\/(?:shared|services)|from ["']electron/);
  assert.match(config, /"main\/index": "src\/main\/bootstrap\.ts"/);
  assert.match(config, /"main\/gui": "src\/main\/gui\.ts"/);
  const gui = await readFile(resolve(desktopRoot, "src/main/gui.ts"), "utf8");
  assert.match(gui, /import "\.\/index\.js"/);
});
