import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/**
 * 材料目录是仓库根下的 checked-in 原文（third-party/upstream/office-runtime）。
 * office-runtime 位于 apps/zcode-cli/packages/office-runtime，根目录上溯四级。
 * 证据按字节校验，文件后缀加 .txt 防止构建工具把快照当成可执行代码。
 */
const materials = resolve(here, "../../../../../third-party/upstream/office-runtime");

/**
 * 分发闭包里没有包内许可文件、但有发布方固定原文的包。
 * 只按精确 name@version + 完整原文 sha256 放行，不接受相邻版本或泛化 SPDX 文本。
 */
const MATERIAL_LICENSES = {
  "saxes@5.0.1": [
    {
      file: "saxes-5.0.1-LICENSE.txt",
      sha256: "0fac2374380621b22e6b50451057721a9c52935b02d16d106a9f04897f061d0e",
    },
  ],
  "@nodable/entities@3.1.0": [
    {
      file: "nodable-entities-3.1.0-LICENSE.txt",
      sha256: "750cb3fb6362804957ef52caaf9b5c824015be44d494637330d7cd8834d31d40",
    },
  ],
  // xlsx 面板的 wasm 工作表引擎；npm 包只有 MIT 字段，没有 LICENSE 文件。
  "@dukelib/sheets-wasm@0.1.21": [
    {
      file: "duke-sheets-wasm-0.1.21-LICENSE.txt",
      sha256: "ebb2e920800c6353474e3e23d84f714ee8aaecd8f5a71851aa03594a4129d855",
    },
  ],
};

/**
 * isarray@1.0.0 发布包没有 LICENSE 文件；仓库既有材料是 README 的完整许可段。
 * 先核对整份 README 的 sha256，再原样截取 `## License` 起的完整正文。
 */
const ISARRAY_README_SHA256 = "ff138e683771b187f3629c383db72ee7d632009010a36d08e18e8d2a34222ec7";
const ISARRAY_LICENSE_START = "## License";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function materialText(key) {
  const entries = MATERIAL_LICENSES[key];
  if (!entries) return null;
  const texts = [];
  for (const entry of entries) {
    const bytes = await readFile(join(materials, entry.file));
    const actual = sha256(bytes);
    if (actual !== entry.sha256)
      throw new Error(
        `License material ${entry.file} changed: ${actual} != ${entry.sha256} (${key})`,
      );
    texts.push(bytes.toString("utf8"));
  }
  return texts.join("\n\n");
}

async function isarrayText(directory) {
  const bytes = await readFile(join(directory, "README.md"));
  const actual = sha256(bytes);
  if (actual !== ISARRAY_README_SHA256)
    throw new Error(`isarray@1.0.0 README changed: ${actual} != ${ISARRAY_README_SHA256}`);
  const text = bytes.toString("utf8");
  const start = text.indexOf(ISARRAY_LICENSE_START);
  if (start < 0) throw new Error("isarray@1.0.0 README has no license section");
  const license = text.slice(start).trim();
  if (!license.includes("Copyright") || !license.includes("THE SOFTWARE IS PROVIDED"))
    throw new Error("isarray@1.0.0 license section is incomplete");
  return license;
}

/**
 * Collect licences from the modules that actually end up in the bundles, including transitive
 * dependencies. A package without a licence file is only accepted when its exact name@version is
 * registered with complete original bytes above; anything else fails the build instead of writing
 * a generic SPDX sentence that loses the copyright notice.
 */
export async function writeNotices(metafiles, destination) {
  const packages = new Map();
  for (const input of metafiles.flatMap((meta) => Object.keys(meta.inputs))) {
    if (!input.includes("node_modules/")) continue;
    let directory = dirname(resolve(input));
    while (directory.includes("node_modules")) {
      try {
        const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
        if (pkg.name) {
          packages.set(directory, pkg);
          break;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      directory = dirname(directory);
    }
  }
  const notices = [];
  const seen = new Set();
  for (const [directory, pkg] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const files = (await readdir(directory)).filter((name) =>
      /^(license|licence|copying|notice)([.-]|$)/i.test(name),
    );
    let texts = await Promise.all(files.map((file) => readFile(join(directory, file), "utf8")));
    if (!texts.length) {
      const material = await materialText(key);
      if (material) texts = [material];
      else if (key === "isarray@1.0.0") texts = [await isarrayText(directory)];
      else
        throw new Error(
          `Missing license text for bundled dependency ${key}; register its exact original bytes`,
        );
    }
    const license =
      typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license ?? null);
    const text = texts.join("\n\n").trim();
    if (!/copyright/i.test(text))
      throw new Error(`License text for bundled dependency ${key} has no copyright notice`);
    notices.push(`${key} — ${license}\n${text}`);
  }
  await writeFile(destination, notices.join("\n\n----------------------------------------\n\n"));
}

/** Every package the server-side bundle actually contains, for the build's stub assertions. */
export function bundledPackageKeys(metafiles) {
  const keys = new Set();
  for (const input of metafiles.flatMap((meta) => Object.keys(meta.inputs))) {
    const match = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (match) keys.add(match[1]);
  }
  return keys;
}
