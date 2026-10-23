import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { writeTarGz } from "../src/tar.js";
import { openLocalVault, encryptArchive, decryptArchive, canonicalJson } from "../src/vault.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "parody-tar-"));
}

test("tar.gz 能被系统 tar 解开，且内容与条目一致", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const fileA = join(dir, "a.txt");
  const fileB = join(dir, "b.txt");
  await rm(fileA, { force: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(fileA, "hello parity\n");
  await writeFile(fileB, "x".repeat(1024));

  const output = join(dir, "out.tar.gz");
  const result = await writeTarGz(
    [
      { path: "a.txt", absolutePath: fileA, sizeBytes: 13 },
      { path: "nested/b.txt", absolutePath: fileB, sizeBytes: 1024 },
    ],
    output,
    { now: () => 1_700_000_000_000 },
  );

  assert.equal(result.fileCount, 2);
  assert.equal(result.plaintextBytes, 13 + 1024);

  const listing = execFileSync("tar", ["-tzvf", output], { encoding: "utf8" });
  assert.match(listing, /a\.txt/u);
  assert.match(listing, /nested\/b\.txt/u);

  const extracted = join(dir, "x");
  execFileSync("tar", ["-xzf", output, "-C", dir]);
  const { readFile: read } = await import("node:fs/promises");
  assert.equal(await read(fileA, "utf8"), "hello parity\n");
  assert.equal((await read(fileB, "utf8")).length, 1024);
  await rm(extracted, { force: true });
});

test("长路径用 ustar prefix 拆分后仍可解开", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { writeFile, readFile: read } = await import("node:fs/promises");
  const deep = `${"segment/".repeat(40)}file.txt`;
  const source = join(dir, "deep.txt");
  await writeFile(source, "deep");

  const output = join(dir, "deep.tar.gz");
  await writeTarGz([{ path: deep, absolutePath: source, sizeBytes: 4 }], output);

  const listing = execFileSync("tar", ["-tzf", output], { encoding: "utf8" });
  assert.match(listing, /file\.txt/u);

  const target = join(dir, "out");
  await import("node:fs/promises").then((fs) => fs.mkdir(target, { recursive: true }));
  execFileSync("tar", ["-xzf", output, "-C", target]);
  assert.equal(await read(join(target, deep), "utf8"), "deep");
});

test("扫描后文件变小会报错而不是产出损坏包", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { writeFile } = await import("node:fs/promises");
  const source = join(dir, "shrink.txt");
  await writeFile(source, "x".repeat(100));

  await assert.rejects(
    writeTarGz(
      [{ path: "shrink.txt", absolutePath: source, sizeBytes: 999 }],
      join(dir, "o.tar.gz"),
    ),
    /扫描后发生变化/u,
  );
});

test("canonicalJson：键排序、跳过 undefined", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(canonicalJson([1, { z: 1, a: 2 }]), '[1,{"a":2,"z":1}]');
});

test("本地密钥对：密文只有本地私钥解得开", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { writeFile, readFile: read } = await import("node:fs/promises");
  const plaintext = join(dir, "plain.tar.gz");
  await writeFile(plaintext, "parity payload ".repeat(200));

  const keysDir = join(dir, "keys");
  const vault = await openLocalVault(keysDir);
  assert.match(vault.keyId, /^[0-9a-f]{16}$/u);

  const encryptedPath = join(dir, "snap.tar.gz.enc");
  const envelopePath = join(dir, "envelope.json");
  const encrypted = await encryptArchive({
    plaintextArchivePath: plaintext,
    encryptedArtifactPath: encryptedPath,
    envelopePath,
    vault,
    workspaceKeyHash: "abc123abc123",
    kind: "baseline",
    manifestHash: "m".repeat(64),
  });

  assert.equal(encrypted.envelope.contentAlgorithm, "aes-256-ctr");
  assert.equal(encrypted.envelope.keyWrapAlgorithm, "rsa-oaep-sha256");
  assert.equal(encrypted.envelope.nonceEncoding, "ciphertext-prefix-16-byte");
  assert.equal(encrypted.envelope.aad.kind, "baseline");

  // 密文前缀是 16 字节 nonce，不等于明文
  const cipher = await read(encryptedPath);
  assert.ok(cipher.length > 16);
  assert.notEqual(cipher.subarray(16, 16 + 14).toString("utf8"), "parity payload");

  // 私钥文件权限 0600
  const mode = (await stat(join(keysDir, "rsa-private.pem"))).mode & 0o777;
  assert.equal(mode, 0o600);

  const restored = join(dir, "restored.tar.gz");
  await decryptArchive({
    envelopePath,
    encryptedArtifactPath: encryptedPath,
    outputPath: restored,
    vault,
  });
  assert.equal(await read(restored, "utf8"), await read(plaintext, "utf8"));
});

test("换一把私钥解不开——证明加密不是摆设", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { writeFile } = await import("node:fs/promises");
  const plaintext = join(dir, "plain.tar.gz");
  await writeFile(plaintext, "secret-ish");

  const vault = await openLocalVault(join(dir, "keys"));
  const encryptedPath = join(dir, "snap.tar.gz.enc");
  const envelopePath = join(dir, "envelope.json");
  await encryptArchive({
    plaintextArchivePath: plaintext,
    encryptedArtifactPath: encryptedPath,
    envelopePath,
    vault,
    workspaceKeyHash: "abc123abc123",
    kind: "baseline",
    manifestHash: "m".repeat(64),
  });

  // 另一套密钥
  const otherVault = await openLocalVault(join(dir, "other-keys"));
  await assert.rejects(
    decryptArchive({
      envelopePath,
      encryptedArtifactPath: encryptedPath,
      outputPath: join(dir, "nope.tar.gz"),
      vault: otherVault,
    }),
    /私钥解不开信封/u,
  );
});
