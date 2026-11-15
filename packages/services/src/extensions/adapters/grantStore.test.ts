import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGrantStore } from "./grantStore.js";

describe("extension grant store", () => {
  it("fails closed for a missing or corrupt grants file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-ext-grants-"));
    const filePath = join(dir, "grants.json");
    const store = createGrantStore({ filePath });
    expect(await store.load()).toEqual([]);
    await writeFile(filePath, "{not json");
    expect(await store.load()).toEqual([]);
    await writeFile(filePath, JSON.stringify({ v: 99, records: [] }));
    expect(await store.load()).toEqual([]);
  });

  it("round-trips records and serializes concurrent saves", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-ext-grants-"));
    const filePath = join(dir, "grants.json");
    const store = createGrantStore({ filePath });
    const record = {
      pluginId: "demo",
      name: "Demo",
      grants: ["projects.read" as const],
      consentVersion: "1.0.0",
      consentedAt: 1,
    };
    await Promise.all([
      store.save([record]),
      store.save([record, { ...record, pluginId: "other" }]),
    ]);
    const loaded = await store.load();
    expect(loaded.map((item) => item.pluginId)).toEqual(["demo", "other"]);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({ v: 1 });
  });
});
