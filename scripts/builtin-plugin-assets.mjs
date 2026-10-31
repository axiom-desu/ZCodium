import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  BUILTIN_PLUGIN_REQUIRED_PATHS,
  cuaRuntimeRequiredPaths,
} from "@zcode/shared/builtin-plugin-assets";
export { validateStagedOfficeViewerAssets } from "@zcode/shared/office-viewer-assets";

/** Validate complete executable/skill inputs before producing an installable release. */
export async function validateBuiltinPluginAssets(
  packagesDirectory,
  { platform = process.platform, arch = process.arch } = {},
) {
  for (const relativePath of [
    ...BUILTIN_PLUGIN_REQUIRED_PATHS,
    ...cuaRuntimeRequiredPaths(platform, arch).map((path) => `node-repl-host/${path}`),
  ]) {
    const path = join(packagesDirectory, relativePath);
    const entry = await stat(path).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!entry?.isFile()) throw new Error(`Missing builtin plugin asset: ${relativePath}`);
  }
}
