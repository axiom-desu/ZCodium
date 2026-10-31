// S10 办公依赖许可登记的正/负例：只接受三个精确 name+version+license 三元组，
// 任何原文、代码、字体分片或登记字段变化都必须 fail closed。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  bundledFontReview,
  isReviewedBundledFontLicense,
  isReviewedLegacyLicense,
  legacyLicenseIdentifier,
  officeIdentifierReviews,
  parseBundledFontSlices,
  readOfficeLicenseReview,
  verifyBundledFontPackage,
  verifyInstalledLegacyPackage,
} from "../license-identifiers.mjs";

const root = resolve(import.meta.dirname, "../..");
const materials = "third-party/upstream/office-runtime";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const font = { name: "@fontsource/noto-sans-sc", version: "5.3.1", license: "OFL-1.1" };

async function materialRoot() {
  const directory = await mkdtemp(join(tmpdir(), "s10-office-materials-"));
  await cp(join(root, materials), join(directory, materials), { recursive: true });
  return directory;
}

function tamperedManifest(mutate) {
  return (async () => {
    const bytes = await readFile(join(root, materials, "noto-sans-sc-5.3.1-slices-400.json.txt"));
    const manifest = JSON.parse(bytes.toString("utf8"));
    mutate(manifest);
    return Buffer.from(JSON.stringify(manifest));
  })();
}

test("历史发布方标识只匹配精确版本，且不接受其他包或其它许可", () => {
  assert.equal(legacyLicenseIdentifier({ name: "buffers", version: "0.1.1" }), "MIT/X11");
  assert.equal(legacyLicenseIdentifier({ name: "buffers", version: "0.1.2" }), undefined);
  assert.equal(legacyLicenseIdentifier({ name: "unrelated", version: "0.1.1" }), undefined);
  for (const [name, version] of [
    ["buffers", "0.1.1"],
    ["chainsaw", "0.1.0"],
  ]) {
    assert.equal(isReviewedLegacyLicense({ name, version, license: "MIT/X11" }), true);
    assert.equal(isReviewedLegacyLicense({ name, version, license: "AGPL-3.0" }), false);
    assert.equal(isReviewedLegacyLicense({ name, version: "9.9.9", license: "MIT/X11" }), false);
  }
  assert.equal(
    isReviewedLegacyLicense({ name: "unknown", version: "0.1.0", license: "MIT/X11" }),
    false,
  );
});

test("随包字体只接受已复核的包、版本与 OFL 标识，不做 OFL 前缀放行", () => {
  assert.equal(isReviewedBundledFontLicense(font), true);
  for (const changed of [
    { name: "@fontsource/unreviewed-font" },
    { version: "5.3.2" },
    { license: "OFL-1.0" },
    { license: "AGPL-3.0" },
    { license: undefined },
  ])
    assert.equal(isReviewedBundledFontLicense({ ...font, ...changed }), false);
});

test("仓库原始材料复核：3 个标识、10 份证据、97 个字体分片", async () => {
  const review = await readOfficeLicenseReview(root);
  assert.deepEqual(
    [...review.reviewed].sort(),
    ["@fontsource/noto-sans-sc@5.3.1:OFL-1.1", "buffers@0.1.1:MIT/X11", "chainsaw@0.1.0:MIT/X11"],
    "登记集合变化时必须显式更新，不能静默放行",
  );
  assert.equal(review.files.length, 10);
  assert.equal(review.font.faces.length, 97);
  assert.equal(
    review.font.faces.reduce((total, face) => total + face.bytes, 0),
    bundledFontReview.sliceTotalBytes,
  );
});

test("登记字段漂移（包名/版本/许可）必须失败", async () => {
  for (const drift of [
    { name: "@fontsource/other-font" },
    { version: "5.3.2" },
    { license: "OFL-1.0" },
  ]) {
    const registry = [
      { ...officeIdentifierReviews[0], ...drift },
      ...officeIdentifierReviews.slice(1),
    ];
    await assert.rejects(
      readOfficeLicenseReview(root, { registry }),
      /未登记的许可三元组|字体/,
      `登记漂移未被阻断: ${JSON.stringify(drift)}`,
    );
  }
  const substituted = officeIdentifierReviews.map((record) =>
    record.name === "buffers"
      ? { ...record, evidence: officeIdentifierReviews[0].evidence }
      : record,
  );
  await assert.rejects(readOfficeLicenseReview(root, { registry: substituted }), /登记证据被替换/);
});

test("原文、代码与字体 CSS 材料被篡改必须失败", async () => {
  const mutations = [
    ["noto-sans-sc-5.3.1-LICENSE.txt", "篡改许可原文"],
    ["noto-sans-sc-5.3.1-400.css.txt", "\n/* 篡改分片索引 */\n"],
    ["noto-sans-sc-5.3.1-slices-400.json.txt", "\n"],
    ["buffers-0.1.1-package.json.txt", "\n"],
    ["buffers-0.1.1-index.js.txt", "\n// 篡改发布代码\n"],
    ["chainsaw-0.1.0-package.json.txt", "\n"],
    ["chainsaw-0.1.0-index.js.txt", "\n// 篡改发布代码\n"],
    ["saxes-5.0.1-LICENSE.txt", "\n篡改上游原文\n"],
    ["nodable-entities-3.1.0-LICENSE.txt", "\n篡改上游原文\n"],
    ["duke-sheets-wasm-0.1.21-LICENSE.txt", "\n篡改上游原文\n"],
  ];
  for (const [file, suffix] of mutations) {
    const directory = await materialRoot();
    await writeFile(join(directory, materials, file), suffix, { flag: "a" });
    await assert.rejects(
      readOfficeLicenseReview(directory),
      /材料(?:字节数|哈希)变化/,
      `篡改未被阻断: ${file}`,
    );
  }
});

test("字体分片清单的数量、单文件哈希与绑定哈希变化必须失败", async () => {
  const changed = await tamperedManifest((manifest) => {
    manifest.faces[0].sha256 = "0".repeat(64);
  });
  assert.throws(() => parseBundledFontSlices(changed), /绑定哈希变化/);

  const removed = await tamperedManifest((manifest) => {
    manifest.faces = manifest.faces.slice(0, 96);
  });
  assert.throws(() => parseBundledFontSlices(removed), /97 项不一致/);

  const renamed = await tamperedManifest((manifest) => {
    manifest.faces[0].file = "noto-sans-sc-9999-400-normal.woff2";
  });
  assert.throws(() => parseBundledFontSlices(renamed), /绑定哈希变化/);

  const bytes = await readFile(join(root, materials, "noto-sans-sc-5.3.1-slices-400.json.txt"));
  assert.throws(
    () => parseBundledFontSlices(bytes, { ...bundledFontReview, version: "5.3.2" }),
    /版本与登记不一致/,
  );
});

test("已安装字体包按 LICENSE、CSS 和逐分片哈希校验，禁止改名或增补分片", async () => {
  const directory = await mkdtemp(join(tmpdir(), "s10-office-font-"));
  await mkdir(join(directory, "files"), { recursive: true });
  const license = Buffer.from("OFL-1.1 fixture license\n");
  const css = Buffer.from("/* fixture */\n");
  const faces = [Buffer.from("fixture-slice-1"), Buffer.from("fixture-slice-2")].map(
    (bytes, index) => ({
      file: `noto-sans-sc-${index + 1}-400-normal.woff2`,
      bytes: bytes.length,
      sha256: sha256(bytes),
    }),
  );
  const fixture = {
    ...font,
    name: "@fontsource/fixture-font",
    licenseFile: { sha256: sha256(license), source: { member: "LICENSE" } },
    cssFile: { sha256: sha256(css), source: { member: "400.css" } },
    faces,
    sliceCount: faces.length,
  };
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: fixture.name, version: fixture.version, license: fixture.license }),
  );
  await writeFile(join(directory, "LICENSE"), license);
  await writeFile(join(directory, "400.css"), css);
  await writeFile(join(directory, "files", faces[0].file), "fixture-slice-1");
  await writeFile(join(directory, "files", faces[1].file), "fixture-slice-2");
  await verifyBundledFontPackage(directory, fixture);

  await writeFile(
    join(directory, "files", faces[0].file),
    "tampered-slice-1".slice(0, "fixture-slice-1".length),
  );
  await assert.rejects(verifyBundledFontPackage(directory, fixture), /分片哈希变化/);
  await writeFile(join(directory, "files", faces[0].file), "fixture-slice-1");
  await writeFile(join(directory, "files", "noto-sans-sc-99-400-normal.woff2"), "extra");
  await assert.rejects(verifyBundledFontPackage(directory, fixture), /分片集合/);
});

test("已安装历史包校验绑定发布代码，且 buffers 不得突然出现许可字段", async () => {
  const directory = await mkdtemp(join(tmpdir(), "s10-office-legacy-"));
  const code = Buffer.from("module.exports = {};\n");
  const record = {
    name: "buffers",
    version: "0.1.1",
    license: "MIT/X11",
    installedLicenseField: "absent",
    codeFile: "index.js",
    codeSha256: sha256(code),
  };
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: "buffers", version: "0.1.1" }),
  );
  await writeFile(join(directory, "index.js"), code);
  await verifyInstalledLegacyPackage(directory, record);

  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: "buffers", version: "0.1.1", license: "MIT" }),
  );
  await assert.rejects(verifyInstalledLegacyPackage(directory, record), /登记前提已变化/);

  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: "buffers", version: "0.1.1" }),
  );
  await writeFile(join(directory, "index.js"), "module.exports = { tampered: true };\n");
  await assert.rejects(verifyInstalledLegacyPackage(directory, record), /已安装代码变化/);
});
