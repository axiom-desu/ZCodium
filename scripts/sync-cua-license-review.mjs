#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveSpawnRuntimeOptions } from "./spawn-command.mjs";
import {
  cuaHash,
  cuaLicensePackages,
  cuaSourceMaterials,
  cuaMaterialFile,
  cuaRegistryFile,
  cuaRegistryUrl,
  renderCuaNotices,
} from "./cua-license-review.mjs";

const root = resolve(import.meta.dirname, "..");
async function download(url, file) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed ${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (file) {
    await mkdir(dirname(resolve(root, file)), { recursive: true });
    await writeFile(resolve(root, file), bytes);
  }
  return bytes;
}
const packages = [];
for (const item of cuaLicensePackages) {
  const url = cuaRegistryUrl(item);
  const rawResponse = await download(url);
  const metadata = JSON.parse(rawResponse);
  if (
    metadata.name !== item.name ||
    metadata.version !== item.version ||
    metadata.license !== item.license ||
    (item.gitHead && metadata.gitHead !== item.revision)
  )
    throw new Error(`Publisher version/revision mismatch: ${item.name}`);
  // 只保存版本/许可/来源与发布档事实，避免收录 publisher 个人联系信息和 npm 内部运维字段。
  const bytes = Buffer.from(
    `${JSON.stringify(
      {
        name: metadata.name,
        version: metadata.version,
        license: metadata.license,
        repository: metadata.repository,
        ...(metadata.gitHead ? { gitHead: metadata.gitHead } : {}),
        dist: {
          integrity: metadata.dist.integrity,
          shasum: metadata.dist.shasum,
          tarball: metadata.dist.tarball,
        },
      },
      null,
      2,
    )}\n`,
  );
  const snapshot = resolve(root, cuaRegistryFile(item.name));
  await mkdir(dirname(snapshot), { recursive: true });
  await writeFile(snapshot, bytes);
  packages.push({
    package: `${item.name}@${item.version}`,
    registrySnapshotKind: "selected-public-version-and-source-fields",
    originalRegistryResponseSha256: cuaHash(rawResponse),
    license: item.license,
    revision: item.revision,
    registryUrl: url,
    registrySha256: cuaHash(bytes),
  });
}
const materials = [];
for (const item of cuaSourceMaterials) {
  const bytes = await download(item.url, cuaMaterialFile(item.id));
  materials.push({ ...item, sha256: cuaHash(bytes) });
}
const bundle = await renderCuaNotices(root);
await writeFile(resolve(root, "third-party/cua-driver/NOTICES.txt"), bundle);
const instructions = await readFile(resolve(root, "third-party/cua-driver/NOTICE.md"));
const inventory = {
  schemaVersion: 1,
  scope:
    "Exact CUA 0.28.2 and UBJS 0.31.0-3 publisher evidence and original license materials; native binaries unchanged, source instructions supplied separately.",
  packages,
  materials,
  noticesSha256: cuaHash(bundle),
  instructionsSha256: cuaHash(instructions),
};
await writeFile(
  resolve(root, "third-party/cua-driver/sources.json"),
  `${JSON.stringify(inventory, null, 2)}\n`,
);
const overridesPath = resolve(root, "third-party/npm-overrides.json");
const overrides = JSON.parse(await readFile(overridesPath, "utf8"));
for (const item of packages) {
  const record = {
    package: item.package,
    license: item.license,
    file: "third-party/cua-driver/NOTICES.txt",
    sha256: inventory.noticesSha256,
    source:
      "third-party/cua-driver/sources.json (bundle of identified original upstream texts and corresponding-source instructions)",
    sourceRevision: item.revision,
    reviewEvidence: {
      registry: item.registryUrl,
      registrySha256: item.registrySha256,
      provenance: "third-party/cua-driver/sources.json",
    },
  };
  const index = overrides.findIndex((old) => old.package === record.package);
  if (index < 0) overrides.push(record);
  else overrides[index] = record;
}
await writeFile(overridesPath, `${JSON.stringify(overrides, null, 2)}\n`);
// 生成受控 JSON 时遵循仓库格式；上游原文/registry 快照仍逐字节保留，绝不送进 formatter。
await promisify(execFile)("pnpm", ["exec", "oxfmt", "--write", overridesPath], {
  cwd: root,
  ...resolveSpawnRuntimeOptions("pnpm"),
});
console.log(
  `CUA/UBJS originals: ${packages.length} exact packages, ${materials.length} source materials`,
);
