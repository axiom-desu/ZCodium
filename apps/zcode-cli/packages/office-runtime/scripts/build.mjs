#!/usr/bin/env node
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keepKindLines } from "./kind-filter.mjs";
import { bundledPackageKeys, writeNotices } from "./licenses.mjs";
import { readPluginName } from "./plugin-name.mjs";

// Builds the plugin package in the current directory into its dist/. The package declares its
// panel title and formats under "office" in package.json.
// 插件名取自 .zcodium-plugin/plugin.json：内置插件包目录名（如 pdf-plugin）与插件名不同。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.cwd();
const pkg = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
const ALL_KINDS = ["docx", "xlsx", "pptx", "pdf"];
const profile = {
  name: await readPluginName(target),
  version: pkg.version,
  title: pkg.office?.title,
  kinds: pkg.office?.kinds,
};
if (
  typeof profile.title?.en !== "string" ||
  typeof profile.title?.["zh-CN"] !== "string" ||
  !Array.isArray(profile.kinds) ||
  !profile.kinds.length ||
  profile.kinds.some((kind) => !ALL_KINDS.includes(kind))
)
  throw new Error(`${target}/package.json: "office" needs title.en, title.zh-CN and kinds`);
const has = (kind) => profile.kinds.includes(kind);

// 构建补丁绑定精确依赖版本：升级包而不重新核对补丁点时必须失败，不能静默打成半成品。
const PINNED_VERSIONS = { "pdfjs-dist": "5.4.296", "@extend-ai/react-xlsx": "0.16.0" };
const require = createRequire(import.meta.url);
for (const [name, expected] of Object.entries(PINNED_VERSIONS)) {
  const actual = require(`${name}/package.json`).version;
  if (actual !== expected)
    throw new Error(`${name}@${actual} is not the pinned ${expected}; re-check the build patches`);
}
// ExcelJS 的流式读写依赖在构建时替换为桩模块，真实包不应出现在分发闭包。
const STUBBED_PACKAGES = new Set(["archiver", "unzipper", "tmp", "fast-csv"]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// pdf 分支校验过的字体许可原文，供通知段落复用（保持原字节，不改写版权行）。
let pdfFontLicense;

const dist = join(target, "dist");
const ui = join(dist, "ui");
const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));
const xlsxRoot = dirname(dirname(require.resolve("@extend-ai/react-xlsx")));
const cjkFontRoot = dirname(require.resolve("@fontsource/noto-sans-sc/package.json"));

await rm(dist, { recursive: true, force: true });
await mkdir(ui, { recursive: true });
await cp(join(root, "LICENSE"), join(dist, "LICENSE"));

if (has("pdf")) {
  // pdf.js data files read by the panel (as resources) and by the server (from disk).
  for (const folder of ["cmaps", "standard_fonts", "wasm"]) {
    await cp(join(pdfjsRoot, folder), join(ui, "pdfjs", folder), {
      recursive: true,
      filter: (path) => !path.endsWith(".js"),
    });
  }
  await cp(join(pdfjsRoot, "build/pdf.worker.min.mjs"), join(ui, "pdf-worker.js"));

  // 系统没有 CJK 字体时的兜底字体（ui/cjkFontRuntime.ts）：Noto Sans SC 400 的编号分片，
  // 每片带自己的 unicode-range，作为同一字体族的多个 FontFace 注册。
  // 分片数量、逐文件哈希与 CSS/许可原文都绑定第三方位记录（third-party/upstream/office-runtime），
  // 不满足即构建失败：字体义务是原样分发，不能在构建期改名、子集化或漏片。
  const fontMaterialPath = join(
    root,
    "../../../../third-party/upstream/office-runtime/noto-sans-sc-5.3.1-slices-400.json.txt",
  );
  const fontMaterial = JSON.parse(await readFile(fontMaterialPath, "utf8"));
  const fontLicense = await readFile(join(cjkFontRoot, "LICENSE"));
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const fontLicenseSha = "18aabf190848725e2576eefb5c29ba06aac1029d02132252a7f312eac2e50cf3";
  if (digest(fontLicense) !== fontLicenseSha)
    throw new Error("Noto Sans SC LICENSE does not match the registered original");
  pdfFontLicense = fontLicense;
  const faces = [];
  await mkdir(join(ui, "fonts"), { recursive: true });
  const css = await readFile(join(cjkFontRoot, "400.css"));
  if (digest(css) !== fontMaterial.cssSha256)
    throw new Error("Noto Sans SC 400.css does not match the registered material");
  const cssFaces = new Map(
    [
      ...css
        .toString("utf8")
        .matchAll(
          /url\(\.\/files\/(noto-sans-sc-\d+-400-normal\.woff2)\)[^;]*;\s*unicode-range:\s*([^;]+);/g,
        ),
    ].map(([, file, unicodeRange]) => [file, unicodeRange.trim()]),
  );
  if (fontMaterial.faces.length !== 97)
    throw new Error(`Noto Sans SC material has ${fontMaterial.faces.length} slices, expected 97`);
  for (const face of fontMaterial.faces) {
    const bytes = await readFile(join(cjkFontRoot, "files", face.file));
    if (bytes.byteLength !== face.bytes || digest(bytes) !== face.sha256)
      throw new Error(`Noto Sans SC slice changed: ${face.file}`);
    if (cssFaces.get(face.file) !== face.unicodeRange)
      throw new Error(`Noto Sans SC unicode-range mismatch: ${face.file}`);
    await cp(join(cjkFontRoot, "files", face.file), join(ui, "fonts", face.file));
    faces.push({ file: `fonts/${face.file}`, unicodeRange: face.unicodeRange });
  }
  if (cssFaces.size !== faces.length)
    throw new Error("Noto Sans SC CSS references slices not present in the material");
  await writeFile(join(ui, "cjk-fallback.json"), JSON.stringify({ faces }));
}

/**
 * Makes the bundles this plugin's: src/profile.ts becomes the plugin's profile, and the format
 * registries keep only the lines tagged with the plugin's formats (`// kind:<format>`).
 */
const officeProfile = {
  name: "office-profile",
  setup(builder) {
    builder.onLoad({ filter: /[\\/]src[\\/]profile\.ts$/ }, () => ({
      contents: `export const PROFILE = ${JSON.stringify(profile)};`,
      loader: "ts",
    }));
    builder.onLoad(
      { filter: /[\\/](src[\\/]adapters[\\/]parsers|ui[\\/]viewers[\\/]registry)\.ts$/ },
      async (args) => ({
        contents: keepKindLines(await readFile(args.path, "utf8"), profile.kinds),
        loader: "ts",
      }),
    );
  },
};

const define = { "process.env.NODE_ENV": '"production"' };
// react-xlsx parses workbooks in a module worker it finds via import.meta.url, which an IIFE bundle
// loses. Ship the worker as an asset and point the library at a blob URL the page creates.
const xlsxWorker = has("xlsx")
  ? await build({
      metafile: true,
      entryPoints: [join(xlsxRoot, "dist/xlsx-worker.js")],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      minify: true,
      legalComments: "none",
      define,
      write: false,
    })
  : null;
if (xlsxWorker) {
  await cp(join(xlsxRoot, "dist/duke_sheets_wasm_bg.wasm"), join(ui, "sheets.wasm"));
  await writeFile(join(ui, "xlsx-worker.js"), xlsxWorker.outputFiles[0].contents);
}
const xlsxWorkerUrl = {
  name: "xlsx-worker-url",
  setup(builder) {
    builder.onLoad(
      { filter: /@extend-ai[\\/]react-xlsx[\\/]dist[\\/]index\.js$/ },
      async (args) => {
        const source = await readFile(args.path, "utf8");
        const needle = 'new URL("./xlsx-worker.js", import.meta.url)';
        if (!source.includes(needle))
          throw new Error("react-xlsx worker URL not found; update the build patch");
        return {
          contents: source.replace(needle, "globalThis.__officeXlsxWorkerUrl"),
          loader: "js",
        };
      },
    );
  },
};
// pdf.js 画布对未嵌入字体只用同名系统字体或通用族；让它经 ui/cjkFontRuntime.ts 取字体链
// （中日韩字体回退，规格见 docs/plugins/2026-10-15-office-viewer-builtin-panels-spec.md §5）。
const pdfjsCanvasFonts = {
  name: "pdfjs-canvas-fonts",
  setup(builder) {
    builder.onLoad({ filter: /pdfjs-dist[\\/]build[\\/]pdf\.mjs$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const chain = 'fontObj.systemFontInfo?.css || `"${name}", ${fontObj.fallbackName}`';
      const needle = `const typeface = ${chain};`;
      if (!source.includes(needle))
        throw new Error("pdf.js canvas font chain not found; update the build patch");
      // 正斜杠：Windows 绝对路径写进 import 语句时不依赖反斜杠转义。
      const hook = JSON.stringify(join(root, "ui/cjkFontRuntime.ts").replaceAll("\\", "/"));
      return {
        contents: `import { pdfTypeface as __officePdfTypeface } from ${hook};\n${source.replace(
          needle,
          () => `const typeface = __officePdfTypeface(fontObj, ${chain});`,
        )}`,
        loader: "js",
      };
    });
  },
};
const app = await build({
  plugins: [officeProfile, xlsxWorkerUrl, pdfjsCanvasFonts],
  metafile: true,
  entryPoints: [join(root, "ui/main.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  define,
  write: false,
  outdir: ui,
  logOverride: { "direct-eval": "silent" },
});
const js = Buffer.from(app.outputFiles.find((file) => file.path.endsWith(".js")).contents);
// Split the bundle into resources below the host's per-read limit, on UTF-8 boundaries.
const scripts = [];
for (let offset = 0; offset < js.length; ) {
  let end = Math.min(offset + 4 * 1024 * 1024, js.length);
  while (end < js.length && (js[end] & 0xc0) === 0x80) end--;
  const name = `bundle-${scripts.length}.txt`;
  scripts.push(name);
  await writeFile(join(ui, name), js.subarray(offset, end));
  offset = end;
}
await writeFile(join(ui, "assets.json"), JSON.stringify({ scripts, scriptBytes: js.length }));
await writeFile(join(ui, "panel.css"), await readFile(join(root, "ui/panel.css"), "utf8"));

const bootstrap = await build({
  plugins: [officeProfile],
  metafile: true,
  entryPoints: [join(root, "ui/bootstrap.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  define,
  write: false,
});
const escapeHtml = (text) =>
  text.replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char],
  );
const html = (await readFile(join(root, "ui/panel.html"), "utf8"))
  .replaceAll("__TITLE__", () => escapeHtml(profile.title.en))
  .replace("/*__BOOTSTRAP__*/", () =>
    bootstrap.outputFiles[0].text.replaceAll("</script", "<\\/script"),
  );
await writeFile(join(ui, "panel.html"), html);

// ExcelJS's streaming reader/writer and CSV support are unused (workbooks load through JSZip);
// stub their dependencies so they are not bundled.
const unusedExcelJsDeps = {
  name: "unused-exceljs-deps",
  setup(builder) {
    builder.onResolve({ filter: /^(archiver|unzipper|tmp|fast-csv)$/ }, (args) => ({
      path: args.path,
      namespace: "unused",
    }));
    builder.onLoad({ filter: /.*/, namespace: "unused" }, (args) => ({
      // Module-level calls (tmp.setGracefulCleanup) must still work; any real use throws.
      contents: `const fail = () => { throw new Error(${JSON.stringify(`${args.path} is not bundled`)}); };
module.exports = new Proxy({}, { get: (_, key) => (key === "setGracefulCleanup" ? () => {} : fail) });`,
      loader: "js",
    }));
  },
};
const server = await build({
  plugins: [officeProfile, unusedExcelJsDeps],
  metafile: true,
  entryPoints: [join(root, "src/adapters/main.ts")],
  outfile: join(dist, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  legalComments: "none",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require=__createRequire(import.meta.url);',
  },
  logOverride: { "direct-eval": "silent" },
});

// Licences of everything bundled, plus the pdf.js / react-xlsx data files copied verbatim.
const serverPackages = bundledPackageKeys([server.metafile]);
for (const name of STUBBED_PACKAGES)
  if (serverPackages.has(name))
    throw new Error(`${name} must not be bundled; the stub replacement is missing`);
const notices = join(dist, "THIRD_PARTY_NOTICES.txt");
await writeNotices(
  [app.metafile, bootstrap.metafile, server.metafile, xlsxWorker?.metafile].filter(Boolean),
  notices,
);
const extra = [
  // ui/icons.tsx copies path data from Lucide.
  `lucide icons (path data in ui/icons.tsx) — ISC\nISC License\n\nCopyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.\n\nTHE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`,
];
if (has("pdf"))
  extra.push(
    `@fontsource/noto-sans-sc (ui/fonts, ui/cjk-fallback.json) — OFL-1.1\n${pdfFontLicense.toString("utf8")}`,
  );
for (const folder of has("pdf") ? ["standard_fonts", "wasm"] : [])
  for (const file of (await readdir(join(pdfjsRoot, folder))).filter((name) =>
    name.startsWith("LICENSE"),
  ))
    extra.push(
      `pdfjs-dist ${folder}/${file}\n${await readFile(join(pdfjsRoot, folder, file), "utf8")}`,
    );
await writeFile(
  notices,
  `${await readFile(notices, "utf8")}\n\n----------------------------------------\n\n${extra.join("\n\n----------------------------------------\n\n")}\n`,
);

// 资源 manifest 以真实构建产物为事实源：列出 dist 下每个文件的大小与 sha256。
// staging 消费者据此展开字体 97 片、pdfjs cmaps/fonts/wasm、worker、NOTICE 与 LICENSE，
// 不再只检查三个入口文件。manifest 自身不能包含自己的哈希（写盘后内容还会变），所以排除它。
const manifestFiles = [];
const collectDistFiles = async (absolute, relativePath) => {
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const path = `${relativePath}/${entry.name}`;
    if (path === "dist/ui/assets.json") continue;
    if (entry.isDirectory()) {
      await collectDistFiles(join(absolute, entry.name), path);
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = await readFile(join(absolute, entry.name));
    manifestFiles.push({ path, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
};
await collectDistFiles(dist, "dist");
manifestFiles.sort((left, right) => left.path.localeCompare(right.path));
await writeFile(
  join(ui, "assets.json"),
  JSON.stringify({ scripts, scriptBytes: js.length, files: manifestFiles }),
);

const kib = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
process.stdout.write(
  `${profile.title.en} UI (${profile.kinds.join(", ")}): ${kib(js.length)} in ${scripts.length} resources, loader ${Math.round(Buffer.byteLength(html) / 1024)} KiB, server packages ${serverPackages.size}, font slices ${has("pdf") ? 97 : 0}\n`,
);
