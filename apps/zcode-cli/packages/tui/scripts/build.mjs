import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const tuiDirectory = resolve(import.meta.dirname, "..");

export async function buildTui() {
  const manifest = JSON.parse(await readFile(resolve(tuiDirectory, "package.json"), "utf8"));
  const externalDependencies = Object.keys(manifest.dependencies).filter(
    (name) => !name.startsWith("@zcode/"),
  ).sort();
  const distDirectory = resolve(tuiDirectory, "dist");
  await mkdir(distDirectory, { recursive: true });
  await build({
    entryPoints: [resolve(tuiDirectory, "src/index.ts")],
    outfile: resolve(distDirectory, "index.js"),
    bundle: true,
    // Workspace exports can point at TypeScript sources. Compile that closure here;
    // OpenTUI and its native/worker assets must retain their package-relative paths.
    external: externalDependencies,
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: true,
    logLevel: "info",
  });
  await writeFile(
    resolve(distDirectory, "runtime-dependencies.json"),
    `${JSON.stringify({ schema: 1, externalDependencies }, null, 2)}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildTui();
}
