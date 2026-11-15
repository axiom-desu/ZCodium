// 插件敏感选项：真实文件层 + bootstrap 生命周期 + 投影/读口负向回归。
// 规格：`.agents/specs/upstream-3.18-plugin-secrets.md`。
// 每个用例用临时目录（ZCODE_STORAGE_DIR 指到 temp），不读真实 HOME/XDG/用户配置，也不连任何远端。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Logger, PluginMetadata } from "@zcode/contracts";
import { pickPortablePluginOptions } from "@zcode/shared";
import {
  configureZCodePlugin,
  readPluginUserOptions,
  resolvePluginConfigView,
  resolveZCodePlugins,
  resetZCodePluginConfig,
  uninstallZCodeMarketplacePlugin,
} from "../src/plugins.js";
import { toPluginInfo } from "../src/zcode-protocol/plugin-protocol-projection.js";

const PLUGIN_NAME = "secret-plugin";
const PLUGIN_ID = `${PLUGIN_NAME}@inline`;
const API_SERVER = `plugin:${PLUGIN_NAME}:api`;
const LEAKY_SERVER = `plugin:${PLUGIN_NAME}:leaky`;
const SECRETS_FILE = "plugin-secrets.json";
const PRIVATE_FILE_MODE = 0o600;
const FILE_MODE_MASK = 0o777;
const USER_TOKEN = "user-token-value";
const WORKSPACE_TOKEN = "workspace-token-value";
const roots: string[] = [];

const noopLogger: Logger = {
  debug: () => {},
  error: () => {},
  info: () => {},
  warn: () => {},
  child: () => noopLogger,
};

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
});

interface Fixture {
  root: string;
  storageDir: string;
  pluginRoot: string;
  secretsPath: string;
  userConfigPath: string;
  options(workingDirectory?: string): {
    env: Record<string, string | undefined>;
    logger: Logger;
    userConfigPath: string;
    workingDirectory?: string;
  };
}

async function writeFileWithDirs(path: string, contents: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "zcode-plugin-secrets-"));
  roots.push(root);
  const storageDir = join(root, "storage");
  const pluginRoot = join(root, "plugin-source", PLUGIN_NAME);
  const userConfigPath = join(root, "user-config.json");
  await writeFileWithDirs(
    join(pluginRoot, ".zcodium-plugin", "plugin.json"),
    JSON.stringify({
      name: PLUGIN_NAME,
      version: "1.0.0",
      userConfig: {
        token: { sensitive: true, type: "string" },
        region: { type: "string", default: "us" },
      },
      mcpServers: {
        // headers 是 secret sink：敏感值可以展开。
        api: {
          type: "http",
          url: "https://mcp.example.com/api",
          headers: { Authorization: "Bearer ${user_config.token}" },
        },
        // url 不是 secret sink：敏感值必须被拒绝，server 被单独禁用。
        leaky: { type: "http", url: "https://mcp.example.com/${user_config.token}" },
      },
    }),
  );
  await writeUserConfig(userConfigPath, pluginRoot);
  return {
    root,
    storageDir,
    pluginRoot,
    secretsPath: join(storageDir, "cli", SECRETS_FILE),
    userConfigPath,
    options: (workingDirectory) => ({
      env: { ZCODE_STORAGE_DIR: storageDir },
      logger: noopLogger,
      userConfigPath,
      ...(workingDirectory ? { workingDirectory } : {}),
    }),
  };
}

async function writeUserConfig(
  path: string,
  pluginRoot: string,
  pluginOptions?: Record<string, Record<string, unknown>>,
): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      plugins: { dirs: [pluginRoot], ...(pluginOptions ? { options: pluginOptions } : {}) },
    }),
  );
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function authorizationHeader(server: unknown): string | undefined {
  if (!server || typeof server !== "object" || !("headers" in server)) return undefined;
  return (server as { headers?: Record<string, string> }).headers?.Authorization;
}

function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

describe("plugin sensitive option storage", () => {
  it("1. keeps a configured sensitive key only in the private file", async () => {
    const fixture = await createFixture();
    await configureZCodePlugin({
      ...fixture.options(fixture.root),
      options: { region: "eu", token: USER_TOKEN },
      pluginId: PLUGIN_ID,
    });

    assert.deepEqual(await readJson(fixture.secretsPath), {
      version: 1,
      user: { [PLUGIN_ID]: { token: USER_TOKEN } },
      workspaces: {},
    });
    if (process.platform !== "win32") {
      assert.equal((await stat(fixture.secretsPath)).mode & FILE_MODE_MASK, PRIVATE_FILE_MODE);
    }
    const userConfigText = await readFile(fixture.userConfigPath, "utf8");
    assert.equal(userConfigText.includes(USER_TOKEN), false);
    // 普通字段仍留在 config.json，不因为分流丢失。
    assert.deepEqual(await readJson(fixture.userConfigPath), {
      plugins: { dirs: [fixture.pluginRoot], options: { [PLUGIN_ID]: { region: "eu" } } },
    });
  });

  it("2. migrates legacy plaintext on the next save and keeps the runtime value", async () => {
    const fixture = await createFixture();
    await writeUserConfig(fixture.userConfigPath, fixture.pluginRoot, {
      [PLUGIN_ID]: { token: "legacy-secret" },
    });

    const before = await resolveZCodePlugins(fixture.options(fixture.root));
    assert.equal(authorizationHeader(before.mcpServers[API_SERVER]), "Bearer legacy-secret");
    // 只读解析不迁移：不创建私有文件，也不改写 config.json。
    await assert.rejects(stat(fixture.secretsPath));
    assert.deepEqual((await readJson<{ plugins: { options: unknown } }>(fixture.userConfigPath)).plugins.options, {
      [PLUGIN_ID]: { token: "legacy-secret" },
    });

    // UI 不回传敏感值：只保存普通键的请求也必须把旧明文迁走。
    await configureZCodePlugin({
      ...fixture.options(fixture.root),
      options: { region: "eu" },
      pluginId: PLUGIN_ID,
    });

    assert.deepEqual((await readJson<{ user: unknown }>(fixture.secretsPath)).user, {
      [PLUGIN_ID]: { token: "legacy-secret" },
    });
    const userConfigText = await readFile(fixture.userConfigPath, "utf8");
    assert.equal(userConfigText.includes("legacy-secret"), false);
    assert.deepEqual(
      (await readJson<{ plugins: { options: unknown } }>(fixture.userConfigPath)).plugins.options,
      { [PLUGIN_ID]: { region: "eu" } },
    );
    const after = await resolveZCodePlugins(fixture.options(fixture.root));
    assert.equal(authorizationHeader(after.mcpServers[API_SERVER]), "Bearer legacy-secret");
  });

  it("3. expands a private value in secret sinks and still rejects other fields", async () => {
    const fixture = await createFixture();
    // 值只在私有文件里，config.json 没有：证明运行时读的是私有文件。
    await writeFileWithDirs(
      fixture.secretsPath,
      JSON.stringify({ version: 1, user: { [PLUGIN_ID]: { token: "runtime-secret" } }, workspaces: {} }),
    );

    const outcome = await resolveZCodePlugins(fixture.options(fixture.root));
    assert.equal(authorizationHeader(outcome.mcpServers[API_SERVER]), "Bearer runtime-secret");
    assert.equal(outcome.mcpServers[LEAKY_SERVER], undefined);
    assert.ok(
      outcome.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "plugin_variable_missing" && diagnostic.pluginId === PLUGIN_ID,
      ),
    );
    assert.equal(jsonText(outcome.diagnostics).includes("runtime-secret"), false);
  });

  it("4. keys workspace secrets by workspace root and prefers the innermost one", async () => {
    const fixture = await createFixture();
    const repositoryRoot = join(fixture.root, "repository");
    const nestedRoot = join(repositoryRoot, "packages", "app");
    await mkdir(join(repositoryRoot, ".git"), { recursive: true });
    await mkdir(nestedRoot, { recursive: true });

    await configureZCodePlugin({
      ...fixture.options(repositoryRoot),
      options: { token: "outer-secret" },
      pluginId: PLUGIN_ID,
      scope: "workspace",
    });
    await configureZCodePlugin({
      ...fixture.options(nestedRoot),
      options: { token: "inner-secret" },
      pluginId: PLUGIN_ID,
      scope: "workspace",
    });

    assert.deepEqual(await readJson<{ workspaces: unknown }>(fixture.secretsPath), {
      version: 1,
      user: {},
      workspaces: {
        [repositoryRoot]: { [PLUGIN_ID]: { token: "outer-secret" } },
        [nestedRoot]: { [PLUGIN_ID]: { token: "inner-secret" } },
      },
    });
    for (const workspaceRoot of [repositoryRoot, nestedRoot]) {
      const workspaceConfig = await readFile(join(workspaceRoot, ".zcodium", "config.json"), "utf8");
      assert.equal(/(outer|inner)-secret/u.test(workspaceConfig), false);
    }

    const nested = await resolveZCodePlugins(fixture.options(nestedRoot));
    assert.equal(authorizationHeader(nested.mcpServers[API_SERVER]), "Bearer inner-secret");
    const outer = await resolveZCodePlugins(fixture.options(repositoryRoot));
    assert.equal(authorizationHeader(outer.mcpServers[API_SERVER]), "Bearer outer-secret");

    // 显式清除最内层：回落到外层 workspace 私有值，而不是清空整条链。
    await configureZCodePlugin({
      ...fixture.options(nestedRoot),
      clearOptionKeys: ["token"],
      options: {},
      pluginId: PLUGIN_ID,
      scope: "workspace",
    });
    const fallback = await resolveZCodePlugins(fixture.options(nestedRoot));
    assert.equal(authorizationHeader(fallback.mcpServers[API_SERVER]), "Bearer outer-secret");
    assert.deepEqual((await readJson<{ workspaces: unknown }>(fixture.secretsPath)).workspaces, {
      [repositoryRoot]: { [PLUGIN_ID]: { token: "outer-secret" } },
    });
  });

  it("5. projects no value but keeps the scope, and the user-only read port stays plugin-scoped", async () => {
    const fixture = await createFixture();
    // 协议 handler 的 user 视图只按默认路径读用户配置；本用例把 HOME 指向临时目录
    // （制品自身的默认路径也是相对 HOME 展开），结束后无条件还原。
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = fixture.root;
    process.env.USERPROFILE = fixture.root;
    try {
      const homeConfigPath = join(fixture.root, ".zcodium", "cli", "config.json");
      await writeUserConfig(homeConfigPath, fixture.pluginRoot);
      // env 置空：只按临时 HOME 下的默认路径读用户配置，不受宿主 ZCODE_* 影响。
      await configureZCodePlugin({
        env: {},
        options: { token: USER_TOKEN },
        pluginId: PLUGIN_ID,
      });
      assert.deepEqual(await readJson(join(fixture.root, ".zcodium", "cli", SECRETS_FILE)), {
        version: 1,
        user: { [PLUGIN_ID]: { token: USER_TOKEN } },
        workspaces: {},
      });

      const configView = await resolvePluginConfigView({ env: {} });
      const outcome = await resolveZCodePlugins({ configResult: configView, env: {} });
      const plugin = outcome.plugins.find((entry) => entry.id === PLUGIN_ID);
      assert.ok(plugin);

      const info = toPluginInfo(plugin, configView);
      // 迁进私有文件的键仍要报 scope：设置页的标记与显式清除按钮依赖它。
      assert.equal(info.optionSources?.token, "user");
      assert.equal(info.configuredOptions?.token, undefined);
      assert.equal(jsonText(info).includes(USER_TOKEN), false);

      assert.deepEqual(await readPluginUserOptions({
        env: {},
        consumerPluginId: PLUGIN_ID,
        pluginId: PLUGIN_ID,
      }), {
        values: { region: "us", token: USER_TOKEN },
      });
      await assert.rejects(
        readPluginUserOptions({
          env: {},
          consumerPluginId: "missing@inline",
          pluginId: "missing@inline",
        }),
        (error: unknown) =>
          (error as { code?: string }).code === "plugin_not_found" &&
          !String((error as Error).message).includes(USER_TOKEN),
      );
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("5c. the trusted user-options port requires the matching consumer plugin", async () => {
    const fixture = await createFixture();
    await assert.rejects(
      readPluginUserOptions({
        ...fixture.options(),
        consumerPluginId: "other@inline",
        pluginId: PLUGIN_ID,
      }),
      (error: unknown) =>
        (error as { code?: string }).code === "plugin_user_options_forbidden" &&
        !String((error as Error).message).includes(USER_TOKEN),
    );
    await assert.rejects(
      readPluginUserOptions({
        ...fixture.options(),
        consumerPluginId: undefined as unknown as string,
        pluginId: PLUGIN_ID,
      }),
      (error: unknown) =>
        (error as { code?: string }).code === "plugin_user_options_forbidden",
    );
  });

  it("5b. workspace secrets never reach the user-only read port", async () => {
    const fixture = await createFixture();
    await configureZCodePlugin({
      ...fixture.options(fixture.root),
      options: { token: WORKSPACE_TOKEN },
      pluginId: PLUGIN_ID,
      scope: "workspace",
    });
    const values = await readPluginUserOptions({
      ...fixture.options(),
      consumerPluginId: PLUGIN_ID,
      pluginId: PLUGIN_ID,
    });
    assert.deepEqual(values, { values: { region: "us" } });
    assert.equal(jsonText(values).includes(WORKSPACE_TOKEN), false);
  });

  it("4b. adjacent workspaces keep separate secrets and clearing one leaves the other", async () => {
    const fixture = await createFixture();
    const first = join(fixture.root, "workspace-a");
    const second = join(fixture.root, "workspace-b");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });

    await configureZCodePlugin({
      ...fixture.options(first),
      options: { token: "first-secret" },
      pluginId: PLUGIN_ID,
      scope: "workspace",
    });
    await configureZCodePlugin({
      ...fixture.options(second),
      options: { token: "second-secret" },
      pluginId: PLUGIN_ID,
      scope: "workspace",
    });

    assert.deepEqual(
      Object.keys((await readJson<{ workspaces: Record<string, unknown> }>(fixture.secretsPath)).workspaces).sort(),
      [first, second].sort(),
    );
    const firstOutcome = await resolveZCodePlugins(fixture.options(first));
    const secondOutcome = await resolveZCodePlugins(fixture.options(second));
    assert.equal(authorizationHeader(firstOutcome.mcpServers[API_SERVER]), "Bearer first-secret");
    assert.equal(authorizationHeader(secondOutcome.mcpServers[API_SERVER]), "Bearer second-secret");

    await configureZCodePlugin({
      ...fixture.options(first),
      clearOptionKeys: ["token"],
      options: {},
      pluginId: PLUGIN_ID,
      scope: "workspace",
    });
    const secondAfterClear = await resolveZCodePlugins(fixture.options(second));
    assert.equal(
      authorizationHeader(secondAfterClear.mcpServers[API_SERVER]),
      "Bearer second-secret",
    );
  });

  it("6. user reset drops the user secret, workspace reset keeps its own", async () => {
    const fixture = await createFixture();
    await configureZCodePlugin({
      ...fixture.options(fixture.root),
      options: { token: USER_TOKEN },
      pluginId: PLUGIN_ID,
    });
    await configureZCodePlugin({
      ...fixture.options(fixture.root),
      options: { token: WORKSPACE_TOKEN },
      pluginId: PLUGIN_ID,
      scope: "workspace",
    });

    await resetZCodePluginConfig({
      ...fixture.options(fixture.root),
      pluginId: PLUGIN_ID,
      scope: "workspace",
    });
    // workspace「恢复继承」只删启用覆盖：私有值保留（两层都还在），与 config.json 同语义。
    assert.deepEqual(await readJson<{ workspaces: unknown }>(fixture.secretsPath), {
      version: 1,
      user: { [PLUGIN_ID]: { token: USER_TOKEN } },
      workspaces: { [fixture.root]: { [PLUGIN_ID]: { token: WORKSPACE_TOKEN } } },
    });

    await resetZCodePluginConfig({ ...fixture.options(fixture.root), pluginId: PLUGIN_ID });
    assert.deepEqual(await readJson<{ user: unknown }>(fixture.secretsPath), {
      version: 1,
      user: {},
      workspaces: { [fixture.root]: { [PLUGIN_ID]: { token: WORKSPACE_TOKEN } } },
    });
  });

  it("6b. uninstall drops the plugin's secrets in every scope and keeps others", async () => {
    const fixture = await createFixture();
    await writeFileWithDirs(
      fixture.secretsPath,
      JSON.stringify({
        version: 1,
        user: { [PLUGIN_ID]: { token: "a" }, "keep@inline": { token: "keep" } },
        workspaces: {
          [fixture.root]: { [PLUGIN_ID]: { token: "b" } },
          [join(fixture.root, "other")]: {
            [PLUGIN_ID]: { token: "c" },
            "keep@inline": { token: "keep-too" },
          },
        },
      }),
    );
    await writeInstalledRecord(fixture);

    const removed = await uninstallZCodeMarketplacePlugin({
      ...fixture.options(fixture.root),
      pluginId: PLUGIN_ID,
    });

    assert.equal(removed?.id, PLUGIN_ID);
    assert.deepEqual(await readJson(fixture.secretsPath), {
      version: 1,
      user: { "keep@inline": { token: "keep" } },
      workspaces: { [join(fixture.root, "other")]: { "keep@inline": { token: "keep-too" } } },
    });
  });

  it("7. backs up a corrupt private file and reports a value-free diagnostic", async () => {
    const fixture = await createFixture();
    const corrupt = '{"version":1,"user":{"secret-plugin@inline":{"token":"corrupt-secret"';
    await writeFileWithDirs(fixture.secretsPath, corrupt);
    const warningArgs: unknown[][] = [];
    const logger: Logger = {
      ...noopLogger,
      warn: (...args: unknown[]) => warningArgs.push(args),
    };

    const outcome = await resolveZCodePlugins({ ...fixture.options(fixture.root), logger });
    const diagnostic = outcome.diagnostics.find(
      (item) => item.code === "plugin_secrets_unreadable",
    );
    assert.equal(diagnostic?.severity, "error");
    assert.equal(jsonText(outcome.diagnostics).includes("corrupt-secret"), false);
    assert.equal(jsonText(warningArgs).includes("corrupt-secret"), false);
    assert.equal(jsonText(warningArgs).includes(fixture.secretsPath), true);
    // 按空处理：需要 token 的 server 按既有规则报缺值。
    assert.equal(outcome.mcpServers[API_SERVER], undefined);

    const secretsDir = join(fixture.storageDir, "cli");
    const backups = (await readdir(secretsDir)).filter((name) =>
      name.startsWith(`${SECRETS_FILE}.corrupt-`),
    );
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(secretsDir, backups[0] ?? ""), "utf8"), corrupt);

    await configureZCodePlugin({
      ...fixture.options(fixture.root),
      options: { token: "fresh-secret" },
      pluginId: PLUGIN_ID,
    });
    assert.deepEqual(await readJson(fixture.secretsPath), {
      version: 1,
      user: { [PLUGIN_ID]: { token: "fresh-secret" } },
      workspaces: {},
    });
    const healed = await resolveZCodePlugins(fixture.options(fixture.root));
    assert.equal(
      healed.diagnostics.some((item) => item.code === "plugin_secrets_unreadable"),
      false,
    );
    assert.equal(authorizationHeader(healed.mcpServers[API_SERVER]), "Bearer fresh-secret");
  });

  it("9b. hides a historic private value after the manifest flips it back to normal", async () => {
    const fixture = await createFixture();
    await writeManifest(fixture, { sensitiveToken: true });
    await configureZCodePlugin({
      ...fixture.options(fixture.root),
      options: { token: "historic-secret" },
      pluginId: PLUGIN_ID,
    });
    // 清单改成普通后只保存另一个普通键：旧私有值仍生效（运行期需要），但不能回显。
    await writeManifest(fixture, { sensitiveToken: false });
    await configureZCodePlugin({
      ...fixture.options(fixture.root),
      options: { region: "eu" },
      pluginId: PLUGIN_ID,
    });
    assert.deepEqual((await readJson<{ user: unknown }>(fixture.secretsPath)).user, {
      [PLUGIN_ID]: { token: "historic-secret" },
    });

    const configView = await resolvePluginConfigView(fixture.options(fixture.root));
    const outcome = await resolveZCodePlugins({
      ...fixture.options(fixture.root),
      configResult: configView,
    });
    assert.equal(authorizationHeader(outcome.mcpServers[API_SERVER]), "Bearer historic-secret");
    const plugin = outcome.plugins.find((entry) => entry.id === PLUGIN_ID);
    assert.ok(plugin);
    const info = toPluginInfo(plugin, configView);
    assert.equal(info.configuredOptions?.token, undefined);
    assert.equal(info.optionSources?.token, "user");
    assert.equal(jsonText(info).includes("historic-secret"), false);
  });

  it("9c. configuring an unloaded plugin writes neither public config nor secrets", async () => {
    const fixture = await createFixture();
    const before = await readFile(fixture.userConfigPath, "utf8");
    await assert.rejects(
      configureZCodePlugin({
        ...fixture.options(fixture.root),
        options: { token: "must-not-land-in-config" },
        pluginId: "missing@inline",
      }),
      /Plugin not found/u,
    );
    assert.equal(await readFile(fixture.userConfigPath, "utf8"), before);
    await assert.rejects(stat(fixture.secretsPath));
  });

  it("8. data sync export never carries a sensitive value or the private file", async () => {
    const fixture = await createFixture();
    await configureZCodePlugin({
      ...fixture.options(fixture.root),
      options: { region: "eu", token: USER_TOKEN },
      pluginId: PLUGIN_ID,
    });
    const configView = await resolvePluginConfigView(fixture.options(fixture.root));
    const outcome = await resolveZCodePlugins({
      ...fixture.options(fixture.root),
      configResult: configView,
    });
    const plugin = outcome.plugins.find((entry) => entry.id === PLUGIN_ID) as PluginMetadata;
    // 运行时视图含真实值，导出仍需按 schema 过滤。
    assert.equal(plugin.configuredOptions?.token, USER_TOKEN);
    assert.deepEqual(
      pickPortablePluginOptions(plugin.configuredOptions ?? {}, plugin.userConfig ?? {}),
      { region: "eu" },
    );
    // 私有文件在 cli 存储根，不在插件目录与 plugins/ 存储目录下。
    assert.equal(fixture.secretsPath.startsWith(join(fixture.storageDir, "cli", "plugins")), false);
    assert.equal(fixture.secretsPath.startsWith(fixture.pluginRoot), false);
    // 投影仍按插件列表脱敏，普通字段保留。
    const info = toPluginInfo(plugin, configView);
    assert.equal(jsonText(info).includes(USER_TOKEN), false);
    assert.equal(info.configuredOptions?.region, "eu");
  });

  it("9. follows a manifest flipping a key between normal and sensitive", async () => {
    const fixture = await createFixture();
    // normal → 值先进 config.json。
    await writeManifest(fixture, { sensitiveToken: false });
    await configureZCodePlugin({
      ...fixture.options(fixture.root),
      options: { token: "plain-secret" },
      pluginId: PLUGIN_ID,
    });
    assert.equal(
      (await readFile(fixture.userConfigPath, "utf8")).includes("plain-secret"),
      true,
    );

    // 清单改成 sensitive：下一次保存（只带普通键）把旧明文迁进私有文件。
    await writeManifest(fixture, { sensitiveToken: true });
    await configureZCodePlugin({
      ...fixture.options(fixture.root),
      options: { region: "eu" },
      pluginId: PLUGIN_ID,
    });
    assert.deepEqual((await readJson<{ user: unknown }>(fixture.secretsPath)).user, {
      [PLUGIN_ID]: { token: "plain-secret" },
    });
    const migrated = await readFile(fixture.userConfigPath, "utf8");
    assert.equal(migrated.includes("plain-secret"), false);
    const runtimeAfterMigrate = await resolveZCodePlugins(fixture.options(fixture.root));
    assert.equal(
      authorizationHeader(runtimeAfterMigrate.mcpServers[API_SERVER]),
      "Bearer plain-secret",
    );

    // sensitive → normal：写普通键时同时删掉私有同名键，新值不被旧私有值盖住。
    await writeManifest(fixture, { sensitiveToken: false });
    await configureZCodePlugin({
      ...fixture.options(fixture.root),
      options: { token: "renamed-plain" },
      pluginId: PLUGIN_ID,
    });
    assert.deepEqual((await readJson<{ user: unknown }>(fixture.secretsPath)).user, {});
    assert.equal(
      (await readFile(fixture.userConfigPath, "utf8")).includes("renamed-plain"),
      true,
    );
    const runtimeAfterFlip = await resolveZCodePlugins(fixture.options(fixture.root));
    assert.equal(
      authorizationHeader(runtimeAfterFlip.mcpServers[API_SERVER]),
      "Bearer renamed-plain",
    );
  });
});

async function writeManifest(
  fixture: Fixture,
  options: { sensitiveToken: boolean },
): Promise<void> {
  await writeFile(
    join(fixture.pluginRoot, ".zcodium-plugin", "plugin.json"),
    JSON.stringify({
      name: PLUGIN_NAME,
      version: "1.0.0",
      userConfig: {
        token: options.sensitiveToken ? { sensitive: true, type: "string" } : { type: "string" },
        region: { type: "string", default: "us" },
      },
      mcpServers: {
        api: {
          type: "http",
          url: "https://mcp.example.com/api",
          headers: { Authorization: "Bearer ${user_config.token}" },
        },
        // url 不是 secret sink：清单改成 normal 后这个 server 也能正常解析。
        leaky: { type: "http", url: "https://mcp.example.com/${user_config.token}" },
      },
    }),
  );
}

async function writeInstalledRecord(fixture: Fixture): Promise<void> {
  const pluginStorageRoot = join(fixture.storageDir, "cli", "plugins");
  await mkdir(pluginStorageRoot, { recursive: true });
  await writeFile(
    join(pluginStorageRoot, "installed_plugins.json"),
    JSON.stringify({
      version: 1,
      plugins: [
        {
          id: PLUGIN_ID,
          name: PLUGIN_NAME,
          marketplace: "inline",
          version: "1.0.0",
          installPath: fixture.pluginRoot,
          installedAt: new Date().toISOString(),
          scope: "user",
        },
      ],
    }),
  );
}
