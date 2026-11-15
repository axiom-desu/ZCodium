// 插件敏感选项私有文件（adapter 层）：真实文件、权限、损坏备份、并发、清理。
// 每个用例使用临时目录，不读真实 HOME/XDG 或用户配置。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  createEmptyPluginSecretsFile,
  getPluginSecretsForScope,
  normalizePluginConfigPathForComparison,
  readPluginSecretsFile,
  removePluginSecrets,
  setPluginSecrets,
  updatePluginSecretsFile,
} from "../src/config/plugin-secrets.adapter.js";

const PRIVATE_FILE_MODE = 0o600;
const FILE_MODE_MASK = 0o777;
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-plugin-secrets-adapter-"));
  roots.push(root);
  return root;
}

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
});

const WRITER_SCRIPT = `
const { updatePluginSecretsFile, setPluginSecrets } = await import(
  process.env.S4B_ADAPTER_URL
);
await updatePluginSecretsFile(process.env.S4B_SECRETS_PATH, (file) =>
  setPluginSecrets(
    file,
    { kind: "user" },
    \`plugin\${process.env.S4B_WRITER_INDEX}@inline\`,
    { token: \`value-\${process.env.S4B_WRITER_INDEX}\` },
    [],
  ),
);
`;

function runWriterProcess(adapterUrl: string, path: string, index: number): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", WRITER_SCRIPT],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          S4B_ADAPTER_URL: adapterUrl,
          S4B_SECRETS_PATH: path,
          S4B_WRITER_INDEX: String(index),
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`writer ${index} exited with ${code}: ${stderr}`));
    });
  });
}

describe("plugin secrets adapter", () => {
  it("returns an empty file when it does not exist and does not create one", async () => {
    const path = join(await tempRoot(), "plugin-secrets.json");
    const read = await readPluginSecretsFile(path);
    assert.equal(read.status, "ok");
    assert.deepEqual(read.file, createEmptyPluginSecretsFile());
    await assert.rejects(stat(path));
    // 内容不变的空操作不落盘。
    await updatePluginSecretsFile(path, (file) => file);
    await assert.rejects(stat(path));
  });

  it("writes 0600 and keeps the lock-ordered read-modify-write result", async () => {
    const path = join(await tempRoot(), "plugin-secrets.json");
    await updatePluginSecretsFile(path, (file) =>
      setPluginSecrets(file, { kind: "user" }, "a@inline", { token: "s3cret" }, []),
    );
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & FILE_MODE_MASK, PRIVATE_FILE_MODE);
    }
    const read = await readPluginSecretsFile(path);
    assert.deepEqual(read.file.user, { "a@inline": { token: "s3cret" } });
  });

  it("serializes writers from separate processes through the same file lock", async () => {
    const path = join(await tempRoot(), "plugin-secrets.json");
    const adapterUrl = new URL("../src/config/plugin-secrets.adapter.ts", import.meta.url).href;
    await Promise.all(
      Array.from({ length: 6 }, (_, index) => runWriterProcess(adapterUrl, path, index)),
    );
    const read = await readPluginSecretsFile(path);
    assert.equal(read.status, "ok");
    assert.deepEqual(Object.keys(read.file.user).sort(), [
      "plugin0@inline",
      "plugin1@inline",
      "plugin2@inline",
      "plugin3@inline",
      "plugin4@inline",
      "plugin5@inline",
    ]);
  });

  it("hardens an existing 0644 file even when the content does not change", async () => {
    const path = join(await tempRoot(), "plugin-secrets.json");
    await writeFile(
      path,
      JSON.stringify({ version: 1, user: { "a@inline": { token: "x" } }, workspaces: {} }),
    );
    if (process.platform !== "win32") await chmod(path, 0o644);

    // 只读路径也修正既有宽松权限。
    assert.equal((await readPluginSecretsFile(path)).status, "ok");
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & FILE_MODE_MASK, PRIVATE_FILE_MODE);
      await chmod(path, 0o644);
    }

    // 内容不变的空操作也要修正权限，不能因为“无需写盘”而留着 0644。
    await updatePluginSecretsFile(path, (file) => file);

    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & FILE_MODE_MASK, PRIVATE_FILE_MODE);
    }
    assert.deepEqual((await readPluginSecretsFile(path)).file.user, {
      "a@inline": { token: "x" },
    });
  });

  it("replaces a symlink instead of following it, and never changes the target", async () => {
    const root = await tempRoot();
    const path = join(root, "plugin-secrets.json");
    const outside = join(root, "outside.json");
    const outsideContent = JSON.stringify({
      version: 1,
      user: { "outside@inline": { token: "outside-secret" } },
      workspaces: {},
    });
    await writeFile(outside, outsideContent);
    await symlink(outside, path);

    // 读路径不跟随 symlink，也不把外部内容备份成“损坏文件”。
    const unsafeRead = await readPluginSecretsFile(path);
    assert.equal(unsafeRead.status, "unreadable");
    assert.deepEqual(unsafeRead.file, createEmptyPluginSecretsFile());
    assert.equal(
      (await readdir(root)).filter((name) => name.includes(".corrupt-")).length,
      0,
    );

    await updatePluginSecretsFile(path, (file) =>
      setPluginSecrets(file, { kind: "user" }, "a@inline", { token: "fresh" }, []),
    );

    const info = await lstat(path);
    assert.equal(info.isSymbolicLink(), false);
    if (process.platform !== "win32") {
      assert.equal(info.mode & FILE_MODE_MASK, PRIVATE_FILE_MODE);
    }
    assert.equal(await readFile(outside, "utf8"), outsideContent);
    assert.deepEqual((await readPluginSecretsFile(path)).file.user, {
      "a@inline": { token: "fresh" },
    });
  });

  it("breaks a hardlink so new secrets are not readable through the other path", async () => {
    if (process.platform === "win32") return;
    const root = await tempRoot();
    const path = join(root, "plugin-secrets.json");
    const outside = join(root, "outside.json");
    const oldContent = JSON.stringify({
      version: 1,
      user: { "a@inline": { token: "old-secret" } },
      workspaces: {},
    });
    await writeFile(path, oldContent);
    await chmod(path, 0o644);
    await link(path, outside);

    await updatePluginSecretsFile(path, (file) =>
      setPluginSecrets(file, { kind: "user" }, "a@inline", { token: "new-secret" }, []),
    );

    const privateInfo = await stat(path);
    const outsideInfo = await stat(outside);
    assert.equal(privateInfo.mode & FILE_MODE_MASK, PRIVATE_FILE_MODE);
    // 原子 rename 断开共享 inode；旧链接被收紧到 0600，读不到新 secret。
    assert.notEqual(privateInfo.ino, outsideInfo.ino);
    assert.equal(outsideInfo.mode & FILE_MODE_MASK, PRIVATE_FILE_MODE);
    assert.equal(await readFile(outside, "utf8"), oldContent);
    assert.equal((await readFile(outside, "utf8")).includes("new-secret"), false);
  });

  it("does not overwrite a corrupt file when the evidence backup fails", async () => {
    if (process.platform === "win32") return;
    const root = await tempRoot();
    const path = join(root, "plugin-secrets.json");
    const corrupt = '{"version":1,"user":{"a@inline":{"token":"corrupt-secret"';
    await writeFile(path, corrupt);
    const digest = createHash("sha256").update(Buffer.from(corrupt)).digest("hex").slice(0, 24);
    // 备份路径放一个自指软链：排他写命中 EEXIST 后 chmod 会 ELOOP，备份失败必须先抛错。
    const backupPath = `${path}.corrupt-${digest}.bak`;
    await symlink(backupPath, backupPath);

    await assert.rejects(
      updatePluginSecretsFile(path, (file) =>
        setPluginSecrets(file, { kind: "user" }, "a@inline", { token: "replacement" }, []),
      ),
      /ELOOP/u,
    );
    assert.equal(await readFile(path, "utf8"), corrupt);
  });

  it("merges concurrent writers without losing entries or corrupting the file", async () => {
    const path = join(await tempRoot(), "plugin-secrets.json");
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        updatePluginSecretsFile(path, (file) =>
          setPluginSecrets(
            file,
            index % 2 === 0 ? { kind: "user" } : { kind: "workspace", root: "/w" },
            `plugin${index}@inline`,
            { token: `value-${index}` },
            [],
          ),
        ),
      ),
    );
    const read = await readPluginSecretsFile(path);
    assert.equal(read.status, "ok");
    assert.equal(Object.keys(read.file.user).length, 12);
    assert.equal(Object.keys(read.file.workspaces["/w"] ?? {}).length, 12);
    // 同一插件的并发写保留最后值，且不残留其他键。
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        updatePluginSecretsFile(path, (file) =>
          setPluginSecrets(file, { kind: "user" }, "shared@inline", { token: `t${index}` }, []),
        ),
      ),
    );
    const after = await readPluginSecretsFile(path);
    assert.deepEqual(Object.keys(after.file.user["shared@inline"] ?? {}), ["token"]);
  });

  it("clears keys and prunes empty plugin/workspace entries", async () => {
    const path = join(await tempRoot(), "plugin-secrets.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        user: { "a@inline": { token: "x", region: "eu" } },
        workspaces: { "/w": { "b@inline": { token: "y" } } },
      }),
    );
    await updatePluginSecretsFile(path, (file) =>
      setPluginSecrets(file, { kind: "user" }, "a@inline", {}, ["token"]),
    );
    assert.deepEqual((await readPluginSecretsFile(path)).file.user, {
      "a@inline": { region: "eu" },
    });
    // workspace 条目清空后不留空壳。
    await updatePluginSecretsFile(path, (file) =>
      removePluginSecrets(file, "b@inline", { kind: "workspace", root: "/w" }),
    );
    assert.deepEqual((await readPluginSecretsFile(path)).file.workspaces, {});
  });

  it("removes a plugin from every scope on uninstall and keeps other plugins", async () => {
    const path = join(await tempRoot(), "plugin-secrets.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        user: { target: { token: "a" }, keep: { token: "keep" } },
        workspaces: {
          "/w1": { target: { token: "b" } },
          "/w2": { target: { token: "c" }, keep: { token: "keep-too" } },
        },
      }),
    );
    await updatePluginSecretsFile(path, (file) => removePluginSecrets(file, "target", "all"));
    assert.deepEqual((await readPluginSecretsFile(path)).file, {
      version: 1,
      user: { keep: { token: "keep" } },
      workspaces: { "/w2": { keep: { token: "keep-too" } } },
    });
  });

  it("backs up a corrupt file once and treats it as empty, then heals on the next write", async () => {
    const root = await tempRoot();
    const path = join(root, "plugin-secrets.json");
    const corrupt = '{"version":1,"user":{"a@inline":{"token":"corrupt-secret"';
    await writeFile(path, corrupt);

    const read = await readPluginSecretsFile(path);
    assert.equal(read.status, "unreadable");
    assert.equal(read.status === "unreadable" ? read.reason : "ok", "corrupt");
    assert.deepEqual(read.file.user, {});
    const backups = (await readdir(root)).filter((name) =>
      name.startsWith("plugin-secrets.json.corrupt-"),
    );
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(root, backups[0] ?? ""), "utf8"), corrupt);

    await updatePluginSecretsFile(path, (file) =>
      setPluginSecrets(file, { kind: "user" }, "a@inline", { token: "fresh" }, []),
    );
    assert.deepEqual((await readPluginSecretsFile(path)).file.user, {
      "a@inline": { token: "fresh" },
    });
    // 备份保留为证据，不会被替换或删除。
    assert.equal(await readFile(join(root, backups[0] ?? ""), "utf8"), corrupt);
  });

  it("keys workspaces by normalized root and rejects malformed values", async () => {
    const file = setPluginSecrets(
      createEmptyPluginSecretsFile(),
      { kind: "workspace", root: "/repo/app" },
      "a@inline",
      { token: "v" },
      [],
    );
    const key = Object.keys(file.workspaces)[0] ?? "";
    assert.equal(normalizePluginConfigPathForComparison(key), normalizePluginConfigPathForComparison("/repo/app"));
    if (process.platform === "win32") {
      assert.equal(
        normalizePluginConfigPathForComparison("C:\\Repo\\App"),
        normalizePluginConfigPathForComparison("c:/repo/app"),
      );
    }
    assert.deepEqual(getPluginSecretsForScope(file, { kind: "workspace", root: "/repo/app" }), {
      "a@inline": { token: "v" },
    });

    const root = await tempRoot();
    const path = join(root, "plugin-secrets.json");
    await writeFile(path, JSON.stringify({ version: 1, user: { a: { token: { nested: true } } } }));
    assert.equal((await readPluginSecretsFile(path)).status, "unreadable");
  });
});
