// S10 办公依赖的精确许可标识登记与材料复核。
//
// 只接受下面三个 name+version+license 组合：两个发布方历史标识（buffers/chainsaw）
// 与一个随插件原样分发的 OFL 字体。登记必须同时命中原始材料字节，因此版本、标识、
// 原文、已发布代码或 97 个字体分片任一变化都会 fail closed。
//
// 这不是 OFL/MIT-X11 的通用放行，不扩展 GREEN 正则，也不关闭
// third-party/inventory.json 既有 strict 16 项。字体只作为 office-runtime 的
// build-only devDependency 与插件资源分发，不进入 packages/ui 生产依赖。
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const materials = "third-party/upstream/office-runtime";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fontTarballUrl =
  "https://registry.npmjs.org/@fontsource/noto-sans-sc/-/noto-sans-sc-5.3.1.tgz";

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message);
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const keyOf = (record) => `${record.name}@${record.version}:${record.license}`;
const ellipsis = /…|\.\.\./u;
// 来源 URL 与哈希必须完整可复核，不允许省略号或截断值。
function assertFixedSource(source, id) {
  assert(source?.url?.startsWith("https://"), `证据来源必须是完整公开 URL: ${id}`);
  assert(!ellipsis.test(source.url), `证据来源 URL 不能省略: ${id}`);
}

const officeEvidence = [
  {
    id: "font-license",
    file: `${materials}/noto-sans-sc-5.3.1-LICENSE.txt`,
    bytes: 4314,
    sha256: "18aabf190848725e2576eefb5c29ba06aac1029d02132252a7f312eac2e50cf3",
    kind: "original-license",
    source: {
      url: fontTarballUrl,
      member: "LICENSE",
      registryIntegrity:
        "sha512-YxZ/VWAWo9FWzH08Q6fGTzIW6vYNP2TMhUFCnfhlimbhdXnWrxJLrzX3KWt2FKnV0s8XiM5vjpGHQiyFRlTj0w==",
    },
    note: "OFL-1.1 原文，版权行 Google Inc.；包内未声明 Reserved Font Name。",
  },
  {
    id: "font-css",
    file: `${materials}/noto-sans-sc-5.3.1-400.css.txt`,
    bytes: 105274,
    sha256: "cd474dcebdf85aa5d537882894217907fcc7db2b990c4e54ef1b924521596260",
    kind: "font-slice-index",
    source: { url: fontTarballUrl, member: "400.css" },
    note: "构建按此 CSS 选择原始 WOFF2 分片；不得改名或子集化。",
  },
  {
    id: "font-slices",
    file: `${materials}/noto-sans-sc-5.3.1-slices-400.json.txt`,
    bytes: 92197,
    sha256: "f835f31159635ab9f69b1617f56bfd35f114974dd6dfebcb2b0489a49f9d365f",
    kind: "font-slice-hashes",
    source: { url: fontTarballUrl, member: "files/*" },
    note: "97 个 400-normal WOFF2 的逐文件 sha256 与字节数清单。",
  },
  {
    id: "buffers-metadata",
    file: `${materials}/buffers-0.1.1-package.json.txt`,
    bytes: 451,
    sha256: "eb42a43d5b685e6de2f2f4a5e18a70255be72349def7eedf504b912dd908913e",
    kind: "publisher-fixed-metadata",
    source: {
      url: "https://raw.githubusercontent.com/bitpay/node-buffers/1b745ee35d33eb166e15ef1866073a07c6d7de87/package.json",
    },
    note: "发布方固定提交为同版补登 MIT/X11；该提交树内没有 LICENSE 文件。",
  },
  {
    id: "buffers-code",
    file: `${materials}/buffers-0.1.1-index.js.txt`,
    bytes: 7057,
    sha256: "97801e296ba5f3c32242f647e1daac5917e300367fed7935ab1e62f40adb1b8a",
    kind: "published-code",
    source: {
      url: "https://registry.npmjs.org/buffers/-/buffers-0.1.1.tgz",
      member: "index.js",
      registryIntegrity:
        "sha512-9q/rDEGSb/Qsvv2qvzIzdluL5k7AaJOTrw23z9reQthrbF7is4CtlT0DXyO1oei2DCp4uojjzQ7igaSHp1kAEQ==",
    },
    note: "npm 发布代码与固定提交逐字节一致，用于把补登标识绑定到实际安装字节。",
  },
  {
    id: "chainsaw-metadata",
    file: `${materials}/chainsaw-0.1.0-package.json.txt`,
    bytes: 618,
    sha256: "51910ad64abca4eb8c2c23abb2f713ba5220db89ed89c9fd198d27241a5a70ea",
    kind: "publisher-metadata",
    source: {
      url: "https://registry.npmjs.org/chainsaw/-/chainsaw-0.1.0.tgz",
      member: "package.json",
      registryIntegrity:
        "sha512-75kWfWt6MEKNC8xYXIdRpDehRYY/tNSgwKaJq+dbbDcxORuVrrQ+SEHoWsniVn9XPYfP4gmdWIeDk/4YNp1rNQ==",
    },
    note: "发布包自身声明 MIT/X11；上游仓库无 LICENSE 文件，不编造全文。",
  },
  {
    id: "chainsaw-code",
    file: `${materials}/chainsaw-0.1.0-index.js.txt`,
    bytes: 3705,
    sha256: "2fd46e18cf7cc2f90684023a951f0289c01316f4fb76cec197da14d0449106ba",
    kind: "published-code",
    source: {
      url: "https://registry.npmjs.org/chainsaw/-/chainsaw-0.1.0.tgz",
      member: "index.js",
      registryIntegrity:
        "sha512-75kWfWt6MEKNC8xYXIdRpDehRYY/tNSgwKaJq+dbbDcxORuVrrQ+SEHoWsniVn9XPYfP4gmdWIeDk/4YNp1rNQ==",
    },
    note: "固定发布包代码，用于证明登记对应当前安装字节。",
  },
  {
    id: "saxes-license",
    file: `${materials}/saxes-5.0.1-LICENSE.txt`,
    bytes: 3011,
    sha256: "0fac2374380621b22e6b50451057721a9c52935b02d16d106a9f04897f061d0e",
    kind: "upstream-tag-license",
    source: { url: "https://raw.githubusercontent.com/lddubeau/saxes/v5.0.1/LICENSE" },
    note: "npm tarball 无 LICENSE；取发布方 v5.0.1 tag 原文，供插件通知使用。",
  },
  {
    id: "nodable-entities-license",
    file: `${materials}/nodable-entities-3.1.0-LICENSE.txt`,
    bytes: 1064,
    sha256: "750cb3fb6362804957ef52caaf9b5c824015be44d494637330d7cd8834d31d40",
    kind: "upstream-tag-license",
    source: { url: "https://raw.githubusercontent.com/nodable/val-parsers/v3.1.0/LICENSE" },
    note: "包内 README 只有 MIT 标签；取发布方 v3.1.0 tag 完整原文。",
  },
  {
    id: "duke-sheets-wasm-license",
    file: `${materials}/duke-sheets-wasm-0.1.21-LICENSE.txt`,
    bytes: 1067,
    sha256: "ebb2e920800c6353474e3e23d84f714ee8aaecd8f5a71851aa03594a4129d855",
    kind: "upstream-tag-license",
    source: {
      url: "https://raw.githubusercontent.com/guseggert/duke-sheets/wasm-v0.1.21/LICENSE",
      registryIntegrity:
        "sha512-YJpLUo/K7N9iGZv+A74D8o6XlT1VjMdlq9i/pIj/DwAO9/7jqppaV60VdL0TgJ0UzUlbhChWR+qQGNTmESINlw==",
    },
    note: "xlsx 面板 wasm 引擎的 npm 包无 LICENSE 文件；取发布方 wasm-v0.1.21 tag 完整 MIT 原文。",
  },
];
const evidence = new Map(officeEvidence.map((item) => [item.id, item]));
const evidenceOf = (...ids) => ids.map((id) => evidence.get(id));

export const bundledFontReview = {
  name: "@fontsource/noto-sans-sc",
  version: "5.3.1",
  license: "OFL-1.1",
  licenseFile: evidence.get("font-license"),
  cssFile: evidence.get("font-css"),
  sliceManifestFile: evidence.get("font-slices"),
  tarball: {
    url: fontTarballUrl,
    sha512:
      "63167f556016a3d156cc7d3c43a7c64f3216eaf60d3f64cc8541429df8658a66e17579d6af124baf35f7296b7614a9d5d2cf1788ce6f8e9187422c854654e3d3",
    sha256: "fd4c218cad77f6f1e9915c45e5d2ede5b0c86dfa0658739684791f50956d1cae",
    bytes: 73551324,
    unpackedFiles: 1905,
    unpackedBytes: 74648760,
  },
  sliceCount: 97,
  sliceTotalBytes: 2382648,
  sliceBindingSha256: "1f4fde6b2546a2a23a956f8e39152db85de8745d62c1526fb72d1e5afe74dbc7",
  reservedFontName: false,
  obligations: [
    "97 个 WOFF2 分片按原字节复制，不改名、不子集化、不修改字体内部名称。",
    "插件产物必须随附完整 OFL-1.1 原文与 Google Inc. 版权行。",
    "不得单独销售字体；字体只作为构建期依赖和插件资源分发。",
  ],
};

const reviewedLegacyPackages = [
  {
    name: "buffers",
    version: "0.1.1",
    license: "MIT/X11",
    installedLicenseField: "absent",
    codeFile: "index.js",
    codeSha256: evidence.get("buffers-code").sha256,
    evidence: evidenceOf("buffers-metadata", "buffers-code"),
    obligations: [
      "npm 发布包没有许可字段，也没有完整许可原文；此处只登记同版标识证据。",
      "只安装不下发：若以后进入发行产物，必须另取该版本完整原文。",
    ],
  },
  {
    name: "chainsaw",
    version: "0.1.0",
    license: "MIT/X11",
    installedLicenseField: "MIT/X11",
    codeFile: "index.js",
    codeSha256: evidence.get("chainsaw-code").sha256,
    evidence: evidenceOf("chainsaw-metadata", "chainsaw-code"),
    obligations: [
      "发布方字段为非 SPDX 拼写 MIT/X11，只按精确版本复核。",
      "只安装不下发：上游无 LICENSE 文件，不编造全文。",
    ],
  },
];

export const officeIdentifierReviews = [
  {
    name: bundledFontReview.name,
    version: bundledFontReview.version,
    license: bundledFontReview.license,
    scope: "build-only-distributed-font",
    evidence: evidenceOf("font-license", "font-css", "font-slices"),
  },
  ...reviewedLegacyPackages.map((record) => ({
    name: record.name,
    version: record.version,
    license: record.license,
    scope: "installed-only",
    evidence: record.evidence,
  })),
];

const fontKey = `${bundledFontReview.name}@${bundledFontReview.version}:${bundledFontReview.license}`;
const legacyKeys = new Set(
  reviewedLegacyPackages.map((record) => `${record.name}@${record.version}:${record.license}`),
);

export function legacyLicenseIdentifier(pkg) {
  return pkg.name === "buffers" && pkg.version === "0.1.1" ? "MIT/X11" : undefined;
}

export function isReviewedLegacyLicense(pkg) {
  return legacyKeys.has(`${pkg.name}@${pkg.version}:${pkg.license}`);
}

// 通用分类未收录 OFL 会让已核验字体阻断；这里只认精确三元组，不放行其他 OFL 字体。
export function isReviewedBundledFontLicense(pkg) {
  return `${pkg.name}@${pkg.version}:${pkg.license}` === fontKey;
}

export function parseBundledFontSlices(bytes, font = bundledFontReview) {
  const manifest = JSON.parse(bytes.toString("utf8"));
  assertEqual(manifest.package, font.name, "字体分片清单的包名与登记不一致");
  assertEqual(manifest.version, font.version, "字体分片清单的版本与登记不一致");
  assertEqual(manifest.css, font.cssFile.source.member, "字体分片清单的 CSS 与登记不一致");
  assertEqual(manifest.cssSha256, font.cssFile.sha256, "字体分片清单的 CSS 哈希与登记不一致");
  assert(Array.isArray(manifest.faces), "字体分片清单缺少 faces");
  assertEqual(manifest.faces.length, font.sliceCount, "字体分片数量与登记的 97 项不一致");
  const seen = new Set();
  const lines = [];
  let totalBytes = 0;
  for (const face of manifest.faces) {
    assert(
      /^noto-sans-sc-\d+-400-normal\.woff2$/u.test(face.file),
      `字体分片文件名不符合原包命名: ${face.file}`,
    );
    assert(!seen.has(face.file), `字体分片重复: ${face.file}`);
    seen.add(face.file);
    assert(Number.isSafeInteger(face.bytes) && face.bytes > 0, `字体分片字节数无效: ${face.file}`);
    assert(/^[a-f0-9]{64}$/u.test(face.sha256), `字体分片哈希无效: ${face.file}`);
    totalBytes += face.bytes;
    lines.push(`${face.sha256}  ${face.file}`);
  }
  assertEqual(totalBytes, font.sliceTotalBytes, "字体分片总字节数变化");
  const binding = sha256(Buffer.from(`${lines.sort().join("\n")}\n`));
  assertEqual(binding, font.sliceBindingSha256, "字体分片绑定哈希变化");
  return manifest.faces;
}

export async function verifyBundledFontPackage(directory, font) {
  const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  assertEqual(pkg.name, font.name, "已安装字体包名与登记不一致");
  assertEqual(pkg.version, font.version, "已安装字体版本与登记不一致");
  assertEqual(pkg.license, font.license, "已安装字体许可标识与登记不一致");
  const licenseBytes = await readFile(join(directory, font.licenseFile.source.member));
  assertEqual(sha256(licenseBytes), font.licenseFile.sha256, "已安装字体 LICENSE 原文变化");
  const cssBytes = await readFile(join(directory, font.cssFile.source.member));
  assertEqual(sha256(cssBytes), font.cssFile.sha256, "已安装字体 400.css 变化");
  const expected = font.faces.map((face) => face.file).sort();
  const installed = (await readdir(join(directory, "files")))
    .filter((name) => /^noto-sans-sc-\d+-400-normal\.woff2$/u.test(name))
    .sort();
  assertEqual(
    JSON.stringify(installed),
    JSON.stringify(expected),
    "已安装字体分片集合与 97 项清单不一致",
  );
  for (const face of font.faces) {
    const bytes = await readFile(join(directory, "files", face.file));
    assertEqual(bytes.length, face.bytes, `已安装字体分片字节数变化: ${face.file}`);
    assertEqual(sha256(bytes), face.sha256, `已安装字体分片哈希变化: ${face.file}`);
  }
}

export async function verifyInstalledLegacyPackage(directory, record) {
  const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  assertEqual(pkg.name, record.name, "已安装包名与历史标识登记不一致");
  assertEqual(pkg.version, record.version, "已安装版本与历史标识登记不一致");
  if (record.installedLicenseField === "absent") {
    // 修复：发布方补登只存在于固定提交；一旦 npm 包自身出现许可字段，登记前提已变，必须重新复核。
    assert(
      pkg.license === undefined && pkg.licenses === undefined,
      `${record.name}@${record.version} 的发布包出现了许可字段，登记前提已变化`,
    );
  } else {
    assertEqual(pkg.license, record.installedLicenseField, "已安装许可字段与登记不一致");
  }
  const code = await readFile(join(directory, record.codeFile));
  assertEqual(sha256(code), record.codeSha256, `${record.name}@${record.version} 已安装代码变化`);
}

export async function readOfficeLicenseReview(
  root,
  { installed, registry = officeIdentifierReviews } = {},
) {
  const files = [];
  const loaded = new Map();
  for (const item of officeEvidence) {
    assertFixedSource(item.source, item.id);
    if (item.source.member)
      assert(!ellipsis.test(item.source.member), `证据成员不能省略: ${item.id}`);
    const bytes = await readFile(join(root, item.file));
    assertEqual(bytes.length, item.bytes, `材料字节数变化: ${item.file}`);
    assertEqual(sha256(bytes), item.sha256, `材料哈希变化: ${item.file}`);
    loaded.set(item.id, bytes);
    files.push(item.file);
  }
  assertFixedSource(bundledFontReview.tarball, "font-tarball");
  assert(!ellipsis.test(bundledFontReview.tarball.url), "字体来源 URL 必须完整");
  assert(
    /^[a-f0-9]{128}$/u.test(bundledFontReview.tarball.sha512),
    "字体 tarball sha512 必须是完整值",
  );
  assert(
    /^[a-f0-9]{64}$/u.test(bundledFontReview.tarball.sha256),
    "字体 tarball sha256 必须是完整值",
  );
  const font = {
    ...bundledFontReview,
    faces: parseBundledFontSlices(loaded.get("font-slices")),
  };
  const licenseText = loaded.get("font-license").toString("utf8");
  assert(licenseText.includes("Google Inc."), "字体 LICENSE 缺少发布方版权行");
  assert(licenseText.includes("SIL Open Font License, Version 1.1"), "字体 LICENSE 不是 OFL-1.1");
  const css = loaded.get("font-css").toString("utf8");
  for (const face of font.faces)
    assert(css.includes(`./files/${face.file}`), `400.css 未引用分片: ${face.file}`);
  const canonical = new Map(officeIdentifierReviews.map((item) => [keyOf(item), item]));
  const reviewed = new Set();
  for (const record of registry) {
    const key = keyOf(record);
    assert(canonical.has(key), `未登记的许可三元组: ${key}`);
    const canonicalIds = canonical
      .get(key)
      .evidence.map((item) => item.id)
      .join(",");
    assertEqual(
      record.evidence?.map((item) => item.id).join(","),
      canonicalIds,
      `登记证据被替换: ${key}`,
    );
    if (record.name !== font.name) {
      const legacy = reviewedLegacyPackages.find((item) => keyOf(item) === key);
      assert(legacy, `历史标识登记缺失: ${key}`);
      const parsed = JSON.parse(loaded.get(legacy.evidence[0].id).toString("utf8"));
      assertEqual(parsed.name, record.name, `发布方 metadata 名称与登记不一致: ${key}`);
      assertEqual(parsed.version, record.version, `发布方 metadata 版本与登记不一致: ${key}`);
      assertEqual(parsed.license, record.license, `发布方 metadata 许可与登记不一致: ${key}`);
    }
    reviewed.add(key);
  }
  if (installed) {
    for (const record of officeIdentifierReviews) {
      const found = installed.get(`${record.name}@${record.version}`);
      assert(found, `登记包未安装: ${record.name}@${record.version}；请先 pnpm install`);
      if (record.name === font.name) await verifyBundledFontPackage(found.directory, font);
      else
        await verifyInstalledLegacyPackage(
          found.directory,
          reviewedLegacyPackages.find((item) => keyOf(item) === keyOf(record)),
        );
    }
  }
  return { reviewed, files, font, legacy: reviewedLegacyPackages };
}
