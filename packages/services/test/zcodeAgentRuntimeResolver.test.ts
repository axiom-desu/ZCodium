import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import test from "node:test";
import { setDataBaseDir } from "../src/paths.js";
import { findDevZCodeCliRustBinary } from "../src/runtime-tools/providerRuntimeResolver.js";
import {
  resolveDefaultZCodeAgentCommand,
  wrapZCodeAgentCommandWithStdioTapDevProxy,
  type ZCodeAgentCommand,
} from "../src/zcode-agent/zcodeAgentProcessManager.js";

const platformKey = `${process.platform}-${process.arch}`;
const rustBinaryName = process.platform === "win32" ? "zcode-cli-rust.exe" : "zcode-cli-rust";
const tsDistEntry = "apps/zcode-cli/packages/cli/dist/zcode.cjs";
const rustResourceEntry = `bundled-agents/${platformKey}/rust/${rustBinaryName}`;

// 这些变量会被 resolver / finder 直接读取；每个用例前后都要恢复，避免污染同进程的其它测试。
const MANAGED_ENV_KEYS = [
  "ZCODE_AGENT_SERVER_RUNTIME",
  "ZCODE_AGENT_SERVER_COMMAND",
  "ZCODE_AGENT_SERVER_ARGS_JSON",
  "ZCODE_AGENT_SERVER_CWD",
  "ZCODE_RUNTIME_ENV",
  "ZCODE_DESKTOP_AGENT_BYTECODE",
  "GLM_BINARY_PATH",
  "ZCODE_DATA_BASE_DIR",
] as const;

const resolverContext = { workspacePath: "/tmp/zcode-m8-workspace" } as const;

async function withIsolatedRepo(
  files: Record<string, string>,
  env: Record<string, string | undefined>,
  fn: (root: string) => void | Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-m8-resolver-"));
  const previousCwd = process.cwd();
  const previousEnv = new Map<string, string | undefined>();
  for (const key of [...MANAGED_ENV_KEYS, "HOME", "USERPROFILE"]) {
    previousEnv.set(key, process.env[key]);
  }

  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const filePath = join(root, relativePath);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
    }
    process.chdir(root);
    // HOME 指向临时根，避免命中开发机真实 ~/.zcodium 里已部署的 native binary。
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    for (const key of MANAGED_ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fn(root);
  } finally {
    process.chdir(previousCwd);
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setDataBaseDir(null);
    await rm(root, { recursive: true, force: true });
  }
}

test("未设置 runtime 时不因随包 Rust 存在而自动选择 Rust", async () => {
  await withIsolatedRepo({ [rustResourceEntry]: "" }, { ZCODE_RUNTIME_ENV: "production" }, () => {
    const command = resolveDefaultZCodeAgentCommand(resolverContext);
    assert.equal(command, null, "默认必须保持 TS；没有 TS bundle 时也不得落回随包 Rust");
  });
});

test("ZCODE_AGENT_SERVER_RUNTIME=ts 不选择随包 Rust", async () => {
  await withIsolatedRepo(
    { [rustResourceEntry]: "" },
    { ZCODE_AGENT_SERVER_RUNTIME: "ts", ZCODE_RUNTIME_ENV: "production" },
    () => {
      const command = resolveDefaultZCodeAgentCommand(resolverContext);
      assert.equal(command, null, "显式 ts 必须与默认一致，不选 Rust");
    },
  );
});

test("显式 zcode-cli-rust 在有 TS bundle 时仍命中 Rust，并声明 native-process 能力", async () => {
  await withIsolatedRepo(
    { [tsDistEntry]: "", [rustResourceEntry]: "" },
    { ZCODE_AGENT_SERVER_RUNTIME: "zcode-cli-rust", ZCODE_RUNTIME_ENV: "production" },
    (root) => {
      const command = resolveDefaultZCodeAgentCommand(resolverContext);
      assert.ok(command, "显式 Rust 必须解析出 command");
      assert.equal(
        command.command,
        resolvePath(root, rustResourceEntry),
        "显式 Rust 必须优先命中随包/仓库内 Rust binary，而不是 TS bundle",
      );
      assert.deepEqual(command.args, ["app-server", "--stdio"]);
      assert.deepEqual(command.storagePreparation, { kind: "native-process" });
      assert.equal(command.supportsStorageStartup, true);
      assert.equal(
        command.env?.ELECTRON_RUN_AS_NODE,
        undefined,
        "native Rust 进程不能带 Electron Node 运行模式",
      );
    },
  );
});

test("显式 zcode-cli-rust 缺 binary 时 fail-closed，不回退 TS", async () => {
  await withIsolatedRepo(
    { [tsDistEntry]: "" },
    { ZCODE_AGENT_SERVER_RUNTIME: "zcode-cli-rust", ZCODE_RUNTIME_ENV: "production" },
    () => {
      assert.throws(
        () => resolveDefaultZCodeAgentCommand(resolverContext),
        /zcode-cli-rust|Rust/i,
        "显式 Rust 缺 binary 必须抛错，不能静默回退 TS bundle",
      );
    },
  );
});

test("未知 ZCODE_AGENT_SERVER_RUNTIME 值明确失败", async () => {
  await withIsolatedRepo(
    { [tsDistEntry]: "" },
    { ZCODE_AGENT_SERVER_RUNTIME: "rust", ZCODE_RUNTIME_ENV: "production" },
    () => {
      assert.throws(
        () => resolveDefaultZCodeAgentCommand(resolverContext),
        /ZCODE_AGENT_SERVER_RUNTIME/,
      );
    },
  );
});

test("ZCODE_AGENT_SERVER_COMMAND 自定义命令优先级最高且不推断存储能力", async () => {
  await withIsolatedRepo(
    { [tsDistEntry]: "", [rustResourceEntry]: "" },
    {
      ZCODE_AGENT_SERVER_RUNTIME: "zcode-cli-rust",
      ZCODE_AGENT_SERVER_COMMAND: "/opt/custom-agent",
      ZCODE_AGENT_SERVER_ARGS_JSON: '["app-server","--stdio","--flag"]',
      ZCODE_RUNTIME_ENV: "production",
    },
    () => {
      const command = resolveDefaultZCodeAgentCommand(resolverContext);
      assert.ok(command);
      assert.equal(command.command, "/opt/custom-agent", "custom command 必须覆盖显式 Rust");
      assert.deepEqual(command.args, ["app-server", "--stdio", "--flag"]);
      assert.equal(command.storagePreparation, undefined);
      assert.equal(command.supportsStorageStartup, undefined, "未知自定义命令不推断存储能力");
    },
  );
});

test("TS bundle 分支声明 node-worker 与 supportsStorageStartup", async () => {
  await withIsolatedRepo(
    { [tsDistEntry]: "" },
    { ZCODE_AGENT_SERVER_RUNTIME: "ts", ZCODE_RUNTIME_ENV: "production" },
    () => {
      const command = resolveDefaultZCodeAgentCommand(resolverContext);
      assert.ok(command);
      const entry = resolvePath(process.cwd(), tsDistEntry);
      assert.equal(command.command, process.execPath);
      assert.equal(command.args?.[0], entry);
      assert.deepEqual(command.storagePreparation, { kind: "node-worker", entry });
      assert.equal(command.supportsStorageStartup, true);
      assert.equal(command.env?.ELECTRON_RUN_AS_NODE, "1");
    },
  );
});

test("开发态 finder 优先 Cargo target/debug，后备 release，且 production 不启用", async () => {
  await withIsolatedRepo(
    {
      [`apps/zcode-cli-rust/target/debug/${rustBinaryName}`]: "",
      [`apps/zcode-cli-rust/target/release/${rustBinaryName}`]: "",
    },
    { ZCODE_RUNTIME_ENV: "development" },
    (root) => {
      assert.equal(
        findDevZCodeCliRustBinary(root),
        resolvePath(root, "apps", "zcode-cli-rust", "target", "debug", rustBinaryName),
        "debug 与 release 同时存在时优先 debug",
      );
    },
  );

  await withIsolatedRepo(
    { [`apps/zcode-cli-rust/target/release/${rustBinaryName}`]: "" },
    { ZCODE_RUNTIME_ENV: "development" },
    (root) => {
      assert.equal(
        findDevZCodeCliRustBinary(root),
        resolvePath(root, "apps", "zcode-cli-rust", "target", "release", rustBinaryName),
        "debug 缺失时后备 release",
      );
    },
  );

  await withIsolatedRepo(
    { [`apps/zcode-cli-rust/target/debug/${rustBinaryName}`]: "" },
    { ZCODE_RUNTIME_ENV: "production" },
    (root) => {
      assert.equal(findDevZCodeCliRustBinary(root), null, "production 不启用开发态 finder");
    },
  );
});

test("tap dev proxy 包装后保留 storagePreparation 与 supportsStorageStartup", async () => {
  await withIsolatedRepo(
    { "scripts/dev/zcode-stdio-tap.mjs": "" },
    { ZCODE_RUNTIME_ENV: "development" },
    (root) => {
      setDataBaseDir(root);
      const devDir = join(root, ".zcodium-exp", "v2", "dev");
      mkdirSync(devDir, { recursive: true });
      writeFileSync(
        join(devDir, "zcode-stdio-tap.json"),
        JSON.stringify({ enabled: true }),
        "utf8",
      );

      const original: ZCodeAgentCommand = {
        command: "/opt/rust-cli",
        args: ["app-server", "--stdio"],
        storagePreparation: { kind: "native-process" },
        supportsStorageStartup: true,
      };
      const wrapped = wrapZCodeAgentCommandWithStdioTapDevProxy(original, "workspace-key");
      assert.equal(wrapped.command, process.execPath, "tap proxy 应替换 transport 包装");
      assert.deepEqual(
        wrapped.storagePreparation,
        { kind: "native-process" },
        "tap proxy 不能丢失存储能力描述",
      );
      assert.equal(wrapped.supportsStorageStartup, true);
      assert.deepEqual(wrapped.args?.slice(0, 1), [
        resolvePath(root, "scripts/dev/zcode-stdio-tap.mjs"),
      ]);
    },
  );
});
