import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const cuaRevision = "fc188250b4ca8549b8e61f937fdb1fb560770e86";
const coreRevision = "49bc59194d183a05855ed4104c18eb92fb465e02";
const nodeRevision = "dcb5c4ab2350d57f6d26f5fa81a99c77ed86d449";
const platforms = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "win32-arm64-msvc",
  "win32-x64-msvc",
];
const raw = (repo, revision, path) =>
  `https://raw.githubusercontent.com/${repo}/${revision}/${path}`;
const packageReview = (name, version, license, revision, gitHead = true) => ({
  name,
  version,
  license,
  revision,
  gitHead,
});
export const cuaLicensePackages = [
  packageReview("@trycua/cua-driver", "0.28.2", "MIT", cuaRevision, false),
  ...platforms.map((platform) =>
    packageReview(
      `@trycua/cua-driver-${platform}`,
      "0.28.2",
      "MIT AND MPL-2.0",
      cuaRevision,
      false,
    ),
  ),
  packageReview("@ubjs/core", "0.31.0-3", "MPL-2.0", coreRevision),
  packageReview("@ubjs/node", "0.31.0-3", "MPL-2.0", nodeRevision),
  ...platforms.map((platform) =>
    packageReview(`@ubjs/node-${platform}`, "0.31.0-3", "MPL-2.0", nodeRevision),
  ),
];
export const cuaSourceMaterials = [
  { id: "cua-MIT", url: raw("trycua/cua", cuaRevision, "LICENSE.md"), kind: "original-license" },
  {
    id: "core-MPL",
    url: raw("jhugman/uniffi-bindgen-react-native", coreRevision, "LICENSE"),
    kind: "original-license",
  },
  {
    id: "node-MPL",
    url: raw("jhugman/uniffi-bindgen-react-native", nodeRevision, "LICENSE"),
    kind: "original-license",
  },
  {
    id: "runtime-NOTICE",
    url: raw("trycua/cua", cuaRevision, "libs/cua-driver/scripts/node-runtime-NOTICE.md"),
    kind: "original-notice",
  },
  {
    id: "runtime-build",
    url: raw("trycua/cua", cuaRevision, "libs/cua-driver/scripts/build-node-runtime.mjs"),
    kind: "build-source",
  },
  {
    id: "cua-package",
    url: raw("trycua/cua", cuaRevision, "libs/cua-driver/typescript/package.json"),
    kind: "version-evidence",
  },
];
export const cuaRegistryFile = (name) =>
  `third-party/cua-driver/registry/${name.replace(/[^a-z0-9.-]/giu, "_")}.json.txt`;
export const cuaMaterialFile = (id) => `third-party/cua-driver/materials/${id}.txt`;
export const cuaRegistryUrl = ({ name, version }) =>
  `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`;
export const cuaHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const key = ({ name, version }) => `${name}@${version}`;

export async function readCuaLicenseReview(root) {
  const file = "third-party/cua-driver/sources.json";
  const inventory = JSON.parse(await readFile(join(root, file), "utf8"));
  if (
    inventory.schemaVersion !== 1 ||
    inventory.packages?.length !== cuaLicensePackages.length ||
    inventory.materials?.length !== cuaSourceMaterials.length
  )
    throw new Error("Incomplete CUA license inventory");
  const files = [file, "third-party/cua-driver/NOTICE.md", "third-party/cua-driver/NOTICES.txt"];
  const { parse } = await import("yaml");
  const lock = parse(await readFile(join(root, "pnpm-lock.yaml"), "utf8"));
  const reviewed = new Set();
  for (const expected of cuaLicensePackages) {
    const matches = inventory.packages.filter((p) => p.package === key(expected));
    const entry = matches[0];
    if (
      matches.length !== 1 ||
      entry.license !== expected.license ||
      entry.revision !== expected.revision ||
      entry.registryUrl !== cuaRegistryUrl(expected) ||
      entry.registrySnapshotKind !== "selected-public-version-and-source-fields" ||
      !/^[a-f0-9]{64}$/u.test(entry.originalRegistryResponseSha256 ?? "")
    )
      throw new Error(`CUA version/expression/source drift: ${key(expected)}`);
    const snapshot = cuaRegistryFile(expected.name);
    const bytes = await readFile(join(root, snapshot));
    if (cuaHash(bytes) !== entry.registrySha256)
      throw new Error(`CUA registry evidence changed: ${key(expected)}`);
    const metadata = JSON.parse(bytes);
    if (
      metadata.name !== expected.name ||
      metadata.version !== expected.version ||
      metadata.license !== expected.license ||
      (expected.gitHead && metadata.gitHead !== expected.revision) ||
      !metadata.dist?.integrity ||
      lock.packages?.[key(expected)]?.resolution?.integrity !== metadata.dist.integrity
    )
      throw new Error(`CUA locked publisher evidence mismatch: ${key(expected)}`);
    files.push(snapshot);
    reviewed.add(`${key(expected)}:${expected.license}`);
  }
  for (const expected of cuaSourceMaterials) {
    const entries = inventory.materials.filter((item) => item.id === expected.id);
    const item = entries[0];
    if (entries.length !== 1 || item.url !== expected.url || item.kind !== expected.kind)
      throw new Error(`CUA material source drift: ${expected.id}`);
    const path = cuaMaterialFile(expected.id);
    if (cuaHash(await readFile(join(root, path))) !== item.sha256)
      throw new Error(`CUA material changed: ${expected.id}`);
    files.push(path);
  }
  const sourcePackage = JSON.parse(
    await readFile(join(root, cuaMaterialFile("cua-package")), "utf8"),
  );
  if (sourcePackage.name !== "@trycua/cua-driver" || sourcePackage.version !== "0.28.2")
    throw new Error("CUA source revision does not match package version");
  // 只批准已证明的精确版本和表达式；MPL 不是通用绿灯，源码获取说明必须实际随 notices 分发。
  const bundle = await readFile(join(root, "third-party/cua-driver/NOTICES.txt"));
  if (cuaHash(bundle) !== inventory.noticesSha256 || !bundle.equals(await renderCuaNotices(root)))
    throw new Error("CUA notices bundle changed");
  const instructions = await readFile(join(root, "third-party/cua-driver/NOTICE.md"));
  if (cuaHash(instructions) !== inventory.instructionsSha256)
    throw new Error("CUA source instructions changed");
  for (const revision of [cuaRevision, coreRevision, nodeRevision])
    if (!instructions.includes(Buffer.from(revision)))
      throw new Error("CUA source instructions omit a pinned revision");
  return { reviewed, files };
}
export async function renderCuaNotices(root) {
  const pieces = [
    Buffer.from("CUA / UBJS THIRD-PARTY NOTICES\n\n"),
    await readFile(join(root, "third-party/cua-driver/NOTICE.md")),
  ];
  for (const item of cuaSourceMaterials.filter(
    ({ kind }) => kind === "original-license" || kind === "original-notice",
  )) {
    pieces.push(
      Buffer.from(`\n\n===== ${item.id}: ${item.url} =====\n\n`),
      await readFile(join(root, cuaMaterialFile(item.id))),
    );
  }
  return Buffer.concat(pieces);
}

export async function verifyCuaLicenseReview(root) {
  return (await readCuaLicenseReview(root)).reviewed;
}
