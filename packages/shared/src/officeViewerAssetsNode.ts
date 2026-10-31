import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  OFFICE_VIEWER_ASSET_MANIFEST_PATH,
  assertOfficeViewerAssetManifest,
  officeViewerKindsFromPackageManifest,
  parseOfficeViewerAssetManifest,
} from "@zcode/shared/office-viewer-assets-contract";

/**
 * office 面板资源闭包的 Node 侧校验器。纯数据契约（路径/闭包/结构）留在
 * `officeViewerAssets.ts`，浏览器 bundle 不因此引入 node:fs。
 *
 * 构建脚本会为每个插件写出带 size/sha256 的 `dist/ui/assets.json`；staging 不能只检查
 * server.mjs/assets.json/panel.html 三个入口，必须展开 manifest 验证字体分片、worker/wasm、
 * NOTICE 的真实存在、大小与哈希。删除任一项都必须在这里 fail closed。
 */
export async function validateOfficeViewerRuntimeAssets(
  pluginRoot: string,
  kinds: readonly string[],
): Promise<void> {
  // 修复：Promise 包装同步读盘仍会阻塞 Agent；所有调用方必须等待真实异步校验后再 promote。

  if (kinds.length === 0) throw new Error(`Office viewer plugin has no kinds: ${pluginRoot}`);
  const root = resolve(pluginRoot);
  const manifestPath = resolve(root, ...OFFICE_VIEWER_ASSET_MANIFEST_PATH.split("/"));
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Missing or invalid office viewer asset manifest: ${manifestPath}`, {
      cause: error,
    });
  }
  const manifest = parseOfficeViewerAssetManifest(raw);
  assertOfficeViewerAssetManifest(manifest, kinds);
  for (const file of manifest.files) {
    const absolute = resolve(root, ...file.path.split("/"));
    // 纯契约已拒绝 `..`/绝对路径；这里再确认解析后的路径仍在插件根目录内。
    if (absolute !== root && !absolute.startsWith(`${root}${sep}`))
      throw new Error(`Office viewer asset escapes the plugin root: ${file.path}`);
    const info = await stat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info?.isFile()) throw new Error(`Office viewer asset is missing: ${file.path}`);
    if (info.size !== file.bytes)
      throw new Error(
        `Office viewer asset size mismatch: ${file.path} (${info.size} != ${file.bytes})`,
      );
    if (
      createHash("sha256")
        .update(await readFile(absolute))
        .digest("hex") !== file.sha256
    )
      throw new Error(`Office viewer asset hash mismatch: ${file.path}`);
  }
}

/** 读插件 package.json 的 office profile；读不到按「非 office 插件」处理，由调用方兜底。 */
export async function readOfficeViewerKinds(pluginRoot: string): Promise<string[]> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(pluginRoot, "package.json"), "utf8"));
    return officeViewerKindsFromPackageManifest(raw);
  } catch {
    return [];
  }
}

/**
 * 目录级（staging/缓存）office 闭包校验：非 office 插件直接跳过；
 * 存在 `dist/ui/assets.json` 却没有 office profile kinds 视为残缺插件（不能静默跳过校验）。
 */
export async function validateStagedOfficeViewerAssets(pluginRoot: string): Promise<void> {
  const kinds = await readOfficeViewerKinds(pluginRoot);
  if (kinds.length > 0) {
    await validateOfficeViewerRuntimeAssets(pluginRoot, kinds);
    return;
  }
  const manifestExists = await access(
    join(pluginRoot, ...OFFICE_VIEWER_ASSET_MANIFEST_PATH.split("/")),
  ).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (manifestExists)
    throw new Error(
      `Office viewer plugin is missing its office profile kinds: ${resolve(pluginRoot)}`,
    );
}
