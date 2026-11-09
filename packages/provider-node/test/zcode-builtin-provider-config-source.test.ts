import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeZCodeBuiltinProviderConfigSource } from "../src/zcode-builtin-provider-config-source.js";

function release(revision: number, logoKey = "fixture-logo"): string {
  return JSON.stringify({
    schemaVersion: 1,
    revision,
    config: {
      providerConfigRules: {
        templateRules: [],
        providerRules: [
          {
            providerId: "account:fixture",
            config: { group: "zai-family", logo: { type: "builtin", key: logoKey } },
          },
        ],
      },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  });
}

const directories: string[] = [];
const sources: NodeZCodeBuiltinProviderConfigSource[] = [];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "zcode-provider-source-test-"));
  directories.push(directory);
  const filePath = join(directory, "zcode-builtin.json");
  return { directory, filePath };
}

function source(filePath: string) {
  const instance = new NodeZCodeBuiltinProviderConfigSource({
    bundledFilePath: filePath,
    watch: false,
  });
  sources.push(instance);
  return instance;
}

afterEach(async () => {
  for (const instance of sources.splice(0)) instance.dispose();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("mutable local bundled source boundary (LKG migration deferred)", () => {
  it("reads runtime edits in the same and a new instance, including same-revision edits", async () => {
    const { directory, filePath } = await fixture();
    await writeFile(filePath, release(1));
    const original = source(filePath);
    const first = await original.read();
    await writeFile(filePath, release(1, "edited-logo"));
    const edited = await original.read();
    expect(edited.revision).not.toBe(first.revision);
    expect(edited.providers.get("account:fixture")?.logo?.key).toBe("edited-logo");
    expect((await source(filePath).read()).revision).toBe(edited.revision);
    await writeFile(filePath, release(2));
    expect((await original.read()).revision).not.toBe(edited.revision);
    expect(await readdir(directory)).toEqual(["zcode-builtin.json"]);
  });

  it("preserves missing-file errors after a prior read and does not recreate bundled", async () => {
    const { directory, filePath } = await fixture();
    await writeFile(filePath, release(1));
    const original = source(filePath);
    await original.read();
    await rm(filePath);
    for (const instance of [original, source(filePath)]) {
      await expect(instance.read()).rejects.toMatchObject({ code: "ENOENT", path: filePath });
    }
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    "{",
    JSON.stringify({ schemaVersion: 999 }),
    release(1).replace("account:fixture", "builtin:zapi"),
  ])("does not hide corrupt/retired content with a previously read value (%s)", async (invalid) => {
    const { filePath } = await fixture();
    await writeFile(filePath, release(1));
    const original = source(filePath);
    await original.read();
    await writeFile(filePath, invalid);
    const before = await stat(filePath);
    await expect(original.read()).rejects.toThrow();
    await expect(source(filePath).read()).rejects.toThrow();
    expect(await readFile(filePath, "utf8")).toBe(invalid);
    expect((await stat(filePath)).mtimeMs).toBe(before.mtimeMs);
  });

  it("preserves first-read ENOENT and successful reads never write files", async () => {
    const { directory, filePath } = await fixture();
    const original = source(filePath);
    await expect(original.read()).rejects.toMatchObject({ code: "ENOENT", path: filePath });
    await writeFile(filePath, release(1));
    const before = await stat(filePath);
    await original.read();
    await source(filePath).read();
    expect((await stat(filePath)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(filePath, "utf8")).toBe(release(1));
    expect(await readdir(directory)).toEqual(["zcode-builtin.json"]);
  });
});
