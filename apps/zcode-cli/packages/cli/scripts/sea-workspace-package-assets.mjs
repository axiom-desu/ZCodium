import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function compiledEntry(value) {
  if (typeof value === "string") {
    if (!value.startsWith("./src/")) return value;
    const path = value.replace(/^\.\/src\//, "./dist/");
    if (/\.d\.[cm]?ts$/.test(path)) return path;
    return path
      .replace(/\.tsx?$/, ".js")
      .replace(/\.mts$/, ".mjs")
      .replace(/\.cts$/, ".cjs");
  }
  if (Array.isArray(value)) return value.map(compiledEntry);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, compiledEntry(entry)]),
    );
  }
  return value;
}

export async function stageSeaPackageAssets({
  packageFiles,
  workspacePackage,
  stagingDirectory,
  assetPrefix,
  runtimeDependencies,
}) {
  const files = [];
  const assets = {};
  for (const file of packageFiles) {
    let sourcePath = file.sourcePath;
    let bytes = await readFile(sourcePath);
    if (workspacePackage && file.assetPath.endsWith("/package.json")) {
      const manifest = JSON.parse(bytes.toString("utf8"));
      if (runtimeDependencies && manifest.name === "@zcode/tui") {
        manifest.dependencies = Object.fromEntries(runtimeDependencies.map((name) => {
          const version = manifest.dependencies?.[name];
          if (!version) throw new Error(`TUI runtime dependency is not declared: ${name}`);
          return [name, version];
        }));
      }
      // 根 workspace 为开发环境导出 src/*.ts；SEA 仅携带 dist，必须在暂存副本改写入口。
      // 不修改源码 manifest，否则会影响桌面 esbuild 的源码解析路径。
      for (const field of ["exports", "main", "module", "types", "imports"]) {
        if (field in manifest) manifest[field] = compiledEntry(manifest[field]);
      }
      bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      sourcePath = resolve(stagingDirectory, file.assetPath);
      await mkdir(dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, bytes);
    }
    assets[`${assetPrefix}${file.assetPath}`] = sourcePath;
    files.push({
      mode: /\.(?:dll|dylib|node|so)$/i.test(file.assetPath) ? 0o755 : 0o644,
      path: file.assetPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return { files, assets };
}
