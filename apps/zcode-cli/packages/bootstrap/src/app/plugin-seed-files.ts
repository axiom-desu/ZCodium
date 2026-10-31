import { readdir } from "node:fs/promises";
import { join } from "node:path";

export async function* walkPluginSeedFiles(
  directory: string,
  allowedTopLevelPaths: ReadonlySet<string>,
  allowedSubtrees: ReadonlySet<string>,
  relativeDirectory = "",
): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (shouldSkipDirectory(entry.name, relativePath, allowedTopLevelPaths, allowedSubtrees))
      continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkPluginSeedFiles(fullPath, allowedTopLevelPaths, allowedSubtrees, relativePath);
      continue;
    }
    if (entry.isFile()) yield fullPath;
  }
}

function shouldSkipDirectory(
  name: string,
  relativePath: string,
  allowedTopLevelPaths: ReadonlySet<string>,
  allowedSubtrees: ReadonlySet<string>,
): boolean {
  if (name === ".turbo" || name === "coverage" || name === ".venv" || name === "__pycache__") {
    return true;
  }
  // 修复：只允许宿主生成的依赖子树，否则首启 seed 会裁掉已打包的 CUA 原生库。
  return (
    name === "node_modules" &&
    !allowedSubtrees.has(relativePath) &&
    !(relativePath === name && allowedTopLevelPaths.has(name))
  );
}

export function shouldIncludePluginSeedFile(
  relativePath: string,
  allowedTopLevelPaths: ReadonlySet<string>,
): boolean {
  const segments = relativePath.split("/");
  if (segments.includes(".DS_Store") || segments.some((segment) => segment.endsWith(".pyc"))) {
    return false;
  }
  const [topLevel] = relativePath.split("/");
  return topLevel !== undefined && allowedTopLevelPaths.has(topLevel);
}
