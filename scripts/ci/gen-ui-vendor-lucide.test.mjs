import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { copyGenUiRuntimeAssets } from "../../packages/desktop/scripts/gen-ui-runtime-assets.mjs";

const root = new URL("../../", import.meta.url);
const assets = new URL("apps/zcode-cli/packages/visualize-plugin/skills/visualize/assets/", root);
const vendorDir = new URL("vendor/", assets);
const provenance = JSON.parse(
  await readFile(new URL("scripts/ci/fixtures/gen-ui-vendor-lucide-1.17.0.json", root), "utf8"),
);
const manifest = JSON.parse(await readFile(new URL("manifest.json", vendorDir), "utf8"));
const lucide = manifest.resources.find((resource) => resource.package === provenance.package);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const legacyFile = "lucide-1.17.0.js";
const legacyLicense = "lucide-1.17.0.js.LICENSE";

/** UMD 发布物按 CommonJS 分支加载；用最小 VM 沙箱拿到导出面，不执行来源页面。 */
function loadUmd(bytes, globals = {}) {
  const module = { exports: {} };
  const context = vm.createContext({ exports: module.exports, module, globalThis: {}, ...globals });
  new vm.Script(bytes.toString("utf8"), { filename: provenance.file }).runInContext(context);
  return module.exports;
}

/** 只实现 createIcons 用到的 DOM 契约，真实走 replaceElement 而不是只读文件是否存在。 */
function fakeDom() {
  const created = [];
  const element = (tagName, attrs = {}) => {
    const node = {
      tagName: tagName.toUpperCase(),
      attrs: { ...attrs },
      children: [],
      parentNode: null,
      setAttribute(name, value) {
        node.attrs[name] = String(value);
      },
      getAttribute(name) {
        return node.attrs[name] ?? null;
      },
      get attributes() {
        return Object.entries(node.attrs).map(([name, value]) => ({ name, value }));
      },
      appendChild(child) {
        node.children.push(child);
        child.parentNode = node;
        return child;
      },
    };
    return node;
  };
  const host = element("i", { "data-lucide": "search" });
  const parent = element("div");
  parent.children.push(host);
  host.parentNode = parent;
  parent.replaceChild = (next, previous) => {
    parent.children[parent.children.indexOf(previous)] = next;
    next.parentNode = parent;
    previous.parentNode = null;
    return next;
  };
  const document = {
    createElementNS(namespace, tagName) {
      const node = element(tagName);
      node.namespaceURI = namespace;
      created.push(node);
      return node;
    },
    querySelectorAll(selector) {
      if (selector === "[data-lucide]") return [host];
      return [];
    },
  };
  return { document, host, parent, created };
}

test("lucide vendor 使用锁定 archive 内的官方 minified UMD 原样字节", async () => {
  assert.ok(lucide, "manifest 缺少 lucide 资源");
  for (const key of [
    "package",
    "version",
    "license",
    "tarball",
    "integrity",
    "source",
    "file",
    "sha256",
    "licenseFile",
    "licenseSha256",
  ])
    assert.equal(lucide[key], provenance[key], `manifest.${key} 与来源记录不一致`);
  assert.equal(lucide.source, provenance.source);
  assert.match(lucide.source, /^dist\/umd\/lucide\.min\.js$/);

  const bytes = await readFile(new URL(lucide.file, vendorDir));
  assert.equal(sha256(bytes), provenance.sha256);
  assert.equal(bytes.length, 402312, "必须与 npm archive 中 dist/umd/lucide.min.js 等长");
  assert.equal(sha256(bytes), lucide.sha256, "manifest sha256 与实际字节不一致");
  // 发布物自带的 @license banner 证明字节来自官方构建，而不是本地压缩结果。
  assert.match(
    bytes.toString("utf8", 0, 120),
    /^\/\*\*\n \* @license lucide v1\.17\.0 - ISC\n/,
    "缺少官方 v1.17.0 ISC banner",
  );
  assert.notEqual(sha256(bytes), provenance.unminifiedSha256, "不能把未压缩 UMD 当成官方 min 资产");

  const license = await readFile(new URL(lucide.licenseFile, vendorDir));
  assert.equal(sha256(license), provenance.licenseSha256);
  assert.equal(sha256(license), lucide.licenseSha256);
  assert.match(license.toString("utf8"), /^ISC License/);
  assert.match(
    license.toString("utf8"),
    /derived from the Feather project/,
    "缺少 Feather MIT 版权段",
  );

  const files = await readdir(vendorDir);
  assert.ok(!files.includes(legacyFile), `旧资产 ${legacyFile} 必须移除`);
  assert.ok(!files.includes(legacyLicense), `旧许可 ${legacyLicense} 必须移除`);
});

test("官方 minified UMD 的导出 API 与全部图标定义锁定在来源 fixture", async () => {
  const exports = loadUmd(await readFile(new URL(lucide.file, vendorDir)));
  const keys = Object.keys(exports).sort();
  assert.equal(keys.length, provenance.exportCount);
  assert.equal(keys.filter((key) => Array.isArray(exports[key])).length, provenance.iconCount);
  assert.deepEqual(
    keys.filter((key) => !Array.isArray(exports[key])),
    provenance.nonIconExports,
  );
  assert.equal(typeof exports.createIcons, "function");
  assert.equal(typeof exports.createElement, "function");
  assert.equal(Object.keys(exports.icons).length, provenance.iconCount);
  // 覆盖所有 1961 个导出的图标节点与别名，而不是只抽样几个名字。
  assert.equal(
    sha256(JSON.stringify(keys.map((key) => [key, exports[key]]))),
    provenance.apiSurfaceSha256,
  );
  for (const [name, shape] of Object.entries(provenance.iconShapes))
    assert.equal(
      JSON.stringify(exports[name]),
      JSON.stringify(shape),
      `${name} 的 SVG 节点定义发生变化`,
    );
});

test("createIcons 仍然把 data-lucide 占位符替换成真实 SVG", async () => {
  const { document, host, parent, created } = fakeDom();
  const exports = loadUmd(await readFile(new URL(lucide.file, vendorDir)), { document });
  exports.createIcons({ root: document });
  const svg = parent.children[0];
  assert.notEqual(svg, host, "占位符没有被替换");
  assert.equal(svg.tagName, "SVG");
  assert.equal(svg.namespaceURI, "http://www.w3.org/2000/svg");
  assert.equal(svg.attrs["aria-hidden"], "true");
  assert.equal(svg.attrs.class, "lucide lucide-search");
  assert.equal(svg.attrs["data-lucide"], "search");
  assert.ok(svg.children.length > 0, "SVG 没有绘制图标子节点");
  const createdTags = created.map((node) => node.tagName);
  assert.ok(createdTags.includes("PATH"));
  assert.ok(createdTags.includes("CIRCLE"));
  assert.equal(created.length, svg.children.length + 1, "应创建 SVG 根节点与全部子节点");
});

test("desktop 打包把新资产按 manifest 字节复制，且不保留旧文件引用", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gen-ui-lucide-"));
  try {
    await copyGenUiRuntimeAssets(directory);
    const copied = await readFile(join(directory, "vendor", lucide.file));
    assert.equal(sha256(copied), lucide.sha256);
    assert.equal(
      sha256(await readFile(join(directory, "vendor", lucide.licenseFile))),
      lucide.licenseSha256,
    );
    const files = await readdir(join(directory, "vendor"));
    assert.ok(!files.includes(legacyFile));
    assert.ok(!files.includes(legacyLicense));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTML、standalone 清单与全部资产注册表都绑定新文件名和同一 URL", async () => {
  const html = await readFile(new URL("visualize.html", assets), "utf8");
  assert.ok(html.includes(`src="${lucide.url}"`), "standalone HTML 未引用 manifest 记录的 URL");
  assert.ok(!html.includes('dist/umd/lucide.js"'), "HTML 仍引用退役的未压缩 URL");
  assert.ok(!html.includes(legacyFile.split(".").slice(0, -1).join(".") + '.js"'));

  const runtimeManifest = JSON.parse(
    await readFile(new URL("runtime-manifest.json", assets), "utf8"),
  );
  assert.equal(
    sha256(await readFile(new URL("visualize.html", assets))),
    runtimeManifest.files["visualize.html"].sha256,
  );

  for (const file of [
    "packages/shared/src/builtinPluginAssets.ts",
    "apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts",
    "apps/zcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs",
  ]) {
    const source = await readFile(new URL(file, root), "utf8");
    assert.ok(
      source.includes(`skills/visualize/assets/vendor/${lucide.file}`),
      `${file} 缺少 ${lucide.file}`,
    );
    assert.ok(
      source.includes(`skills/visualize/assets/vendor/${lucide.licenseFile}`),
      `${file} 缺少 ${lucide.licenseFile}`,
    );
    assert.ok(!source.includes(legacyFile), `${file} 仍引用旧资产`);
  }

  const offlineChecks = await readFile(
    new URL("packages/desktop/scripts/gen-ui-fixture/offline-checks.ts", root),
    "utf8",
  );
  assert.ok(offlineChecks.includes(`"${lucide.file}"`), "离线 fixture 未探测新资产");
  assert.ok(!offlineChecks.includes(`"${legacyFile}"`), "离线 fixture 仍探测旧资产");
});
