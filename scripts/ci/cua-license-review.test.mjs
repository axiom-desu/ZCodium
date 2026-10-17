import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import {
  cuaHash,
  cuaLicensePackages,
  cuaSourceMaterials,
  cuaRegistryFile,
  cuaMaterialFile,
  cuaRegistryUrl,
  renderCuaNotices,
  readCuaLicenseReview,
} from "../cua-license-review.mjs";

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), "cua-license-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (file, data) => {
    await mkdir(dirname(resolve(root, file)), { recursive: true });
    await writeFile(resolve(root, file), data);
  };
  const packages = [];
  for (const item of cuaLicensePackages) {
    const integrity = `sha512-${Buffer.from(item.name).toString("base64")}`;
    const bytes = Buffer.from(
      JSON.stringify({
        name: item.name,
        version: item.version,
        license: item.license,
        gitHead: item.revision,
        dist: { integrity },
      }),
    );
    await put(cuaRegistryFile(item.name), bytes);
    packages.push({
      package: `${item.name}@${item.version}`,
      license: item.license,
      revision: item.revision,
      registryUrl: cuaRegistryUrl(item),
      registrySha256: cuaHash(bytes),
      registrySnapshotKind: "selected-public-version-and-source-fields",
      originalRegistryResponseSha256: cuaHash(bytes),
    });
  }
  await put(
    "pnpm-lock.yaml",
    JSON.stringify({
      packages: Object.fromEntries(
        cuaLicensePackages.map((item) => [
          `${item.name}@${item.version}`,
          { resolution: { integrity: `sha512-${Buffer.from(item.name).toString("base64")}` } },
        ]),
      ),
    }),
  );
  const materials = [];
  for (const item of cuaSourceMaterials) {
    const bytes = Buffer.from(
      item.id === "cua-package"
        ? JSON.stringify({ name: "@trycua/cua-driver", version: "0.28.2" })
        : `Original fixture: ${item.id}`,
    );
    await put(cuaMaterialFile(item.id), bytes);
    materials.push({ ...item, sha256: cuaHash(bytes) });
  }
  const instructions = Buffer.from(cuaLicensePackages.map((item) => item.revision).join("\n"));
  await put("third-party/cua-driver/NOTICE.md", instructions);
  const bundle = await renderCuaNotices(root);
  await put("third-party/cua-driver/NOTICES.txt", bundle);
  const inventory = {
    schemaVersion: 1,
    packages,
    materials,
    instructionsSha256: cuaHash(instructions),
    noticesSha256: cuaHash(bundle),
  };
  const save = () => put("third-party/cua-driver/sources.json", JSON.stringify(inventory));
  await save();
  return { root, inventory, save, put };
}

test("CUA review covers exactly the 15 pinned versions, not other MPL dependencies", async (t) => {
  const { root } = await fixture(t);
  const result = await readCuaLicenseReview(root);
  assert.equal(result.reviewed.size, 15);
  assert.ok(result.reviewed.has("@trycua/cua-driver-linux-x64-gnu@0.28.2:MIT AND MPL-2.0"));
  assert.ok(!result.reviewed.has("@trycua/cua-driver-linux-x64-gnu@0.28.3:MIT AND MPL-2.0"));
  assert.ok(!result.reviewed.has("@ubjs/node@0.31.0-3:GPL-3.0"));
});

test("CUA review rejects missing packages and changed license expressions", async (t) => {
  const f = await fixture(t);
  f.inventory.packages[1].license = "MIT";
  await f.save();
  await assert.rejects(readCuaLicenseReview(f.root), /expression/);
  f.inventory.packages.pop();
  await f.save();
  await assert.rejects(readCuaLicenseReview(f.root), /Incomplete/);
});

test("CUA publisher metadata must match version, gitHead and frozen lock integrity", async (t) => {
  const f = await fixture(t);
  const item = cuaLicensePackages.find(({ name }) => name === "@ubjs/node");
  const path = cuaRegistryFile(item.name);
  const metadata = JSON.parse(await readFile(resolve(f.root, path), "utf8"));
  metadata.gitHead = "0".repeat(40);
  const bytes = Buffer.from(JSON.stringify(metadata));
  await f.put(path, bytes);
  f.inventory.packages.find(({ package: id }) => id === "@ubjs/node@0.31.0-3").registrySha256 =
    cuaHash(bytes);
  await f.save();
  await assert.rejects(readCuaLicenseReview(f.root), /publisher evidence/);
});

test("CUA integrity belonging only to another lock entry cannot approve the package", async (t) => {
  const f = await fixture(t);
  const lock = JSON.parse(await readFile(resolve(f.root, "pnpm-lock.yaml"), "utf8"));
  const item = lock.packages["@ubjs/node@0.31.0-3"];
  lock.packages["unrelated-package@1.0.0"] = item;
  delete lock.packages["@ubjs/node@0.31.0-3"];
  await f.put("pnpm-lock.yaml", JSON.stringify(lock));
  await assert.rejects(readCuaLicenseReview(f.root), /publisher evidence/);
});

test("CUA review rejects altered original material or a bundle omitting license text", async (t) => {
  const f = await fixture(t);
  await f.put(cuaMaterialFile("core-MPL"), "changed");
  await assert.rejects(readCuaLicenseReview(f.root), /material changed/);
  f.inventory.materials.find(({ id }) => id === "core-MPL").sha256 = cuaHash(
    Buffer.from("changed"),
  );
  await f.save();
  await assert.rejects(readCuaLicenseReview(f.root), /bundle changed/);
});

test("checked-in CUA originals match publisher evidence and the frozen npm lock", async () => {
  const result = await readCuaLicenseReview(resolve(import.meta.dirname, "../.."));
  assert.equal(result.reviewed.size, 15);
});
