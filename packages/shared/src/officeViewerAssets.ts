import { OFFICE_VIEWER_RUNTIME_PATHS } from "@zcode/shared/builtin-plugin-assets";

/** 构建产物 manifest 文件名（相对插件根目录），与 `OFFICE_VIEWER_RUNTIME_PATHS` 同源。 */
export const OFFICE_VIEWER_ASSET_MANIFEST_PATH = "dist/ui/assets.json" as const;
/** pdf 面板的 Noto Sans SC 分片数量；构建脚本与 staging 校验都绑定这一固定值。 */
export const OFFICE_VIEWER_PDF_FONT_SLICE_COUNT = 97;

/** 构建脚本写入 `dist/ui/assets.json` 的单文件记录（路径相对插件根目录）。 */
export interface OfficeViewerAssetFile {
  path: string;
  bytes: number;
  sha256: string;
}

/**
 * seed/缓存校验用的文件集条目：只声明调用方真能证明的部分。
 * filesystem seed 有真实字节，SEA seed 只有清单里的 sha256，缓存目录只有 stat 大小。
 */
export interface OfficeViewerAssetSeedFile {
  path: string;
  sha256?: string;
  bytes?: number;
}

/** `findOfficeViewerAssetSeedClosureMismatch` 的首个不一致项。 */
export interface OfficeViewerAssetSeedMismatch {
  path: string;
  reason: string;
}

/** 构建/打包共用的纯数据契约；不导入任何 Node IO，浏览器侧可安全引用。 */
export interface OfficeViewerAssetManifest {
  scripts: readonly string[];
  scriptBytes: number;
  files: readonly OfficeViewerAssetFile[];
}

/**
 * 拒绝绝对路径、盘符、反斜杠、空段与 `..`。staging 会拿 manifest 里的路径直接拼到插件根目录，
 * 不能只信任构建脚本；未知/篡改的 manifest 必须在拼路径前失败。
 */
export function isSafeOfficeViewerAssetPath(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\\") || value.includes("\0"))
    return false;
  if (value.startsWith("/") || /^[A-Za-z]:/u.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** 校验 manifest 结构并返回强类型值；只做纯数据校验，不触碰文件系统。 */
export function parseOfficeViewerAssetManifest(raw: unknown): OfficeViewerAssetManifest {
  if (!raw || typeof raw !== "object")
    throw new Error("Office viewer asset manifest must be an object");
  const candidate = raw as { scripts?: unknown; scriptBytes?: unknown; files?: unknown };
  if (!Array.isArray(candidate.scripts) || candidate.scripts.length === 0)
    throw new Error("Office viewer asset manifest is missing scripts");
  for (const script of candidate.scripts)
    if (!isSafeOfficeViewerAssetPath(script) || script.includes("/"))
      throw new Error(`Unsafe office viewer script name: ${String(script)}`);
  if (
    typeof candidate.scriptBytes !== "number" ||
    !Number.isInteger(candidate.scriptBytes) ||
    candidate.scriptBytes <= 0
  )
    throw new Error("Office viewer asset manifest has an invalid scriptBytes value");
  if (!Array.isArray(candidate.files) || candidate.files.length === 0)
    throw new Error("Office viewer asset manifest is missing the file list");
  const seen = new Set<string>();
  const files: OfficeViewerAssetFile[] = [];
  for (const entry of candidate.files) {
    if (!entry || typeof entry !== "object") throw new Error("Invalid office viewer asset entry");
    const file = entry as { path?: unknown; bytes?: unknown; sha256?: unknown };
    if (!isSafeOfficeViewerAssetPath(file.path))
      throw new Error(`Unsafe office viewer asset path: ${String(file.path)}`);
    if (seen.has(file.path)) throw new Error(`Duplicate office viewer asset path: ${file.path}`);
    seen.add(file.path);
    if (typeof file.bytes !== "number" || !Number.isInteger(file.bytes) || file.bytes < 0)
      throw new Error(`Invalid office viewer asset size: ${file.path}`);
    if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(file.sha256))
      throw new Error(`Invalid office viewer asset hash: ${file.path}`);
    files.push({ path: file.path, bytes: file.bytes, sha256: file.sha256.toLowerCase() });
  }
  return { scripts: [...candidate.scripts] as string[], scriptBytes: candidate.scriptBytes, files };
}

/**
 * 面板 profile 决定真实资源闭包：只有 pdf 带 97 片字体/worker/pdfjs，xlsx 带 worker/wasm。
 * 这里返回必须在 manifest 中出现的完整路径；没有真实 wasm 的 docx/pptx 不在其中。
 */
export function officeViewerRequiredAssetPaths(kinds: readonly string[]): string[] {
  // manifest 自身不能出现在自己的文件清单里（写入后内容还会变），existence 由适配器读取时校验。
  const required = [
    ...OFFICE_VIEWER_RUNTIME_PATHS.filter((path) => path !== OFFICE_VIEWER_ASSET_MANIFEST_PATH),
    "dist/ui/panel.css",
  ];
  if (kinds.includes("pdf")) required.push("dist/ui/cjk-fallback.json", "dist/ui/pdf-worker.js");
  if (kinds.includes("xlsx")) required.push("dist/ui/sheets.wasm", "dist/ui/xlsx-worker.js");
  return required;
}

/** 目录型资源（pdfjs/cmaps 等）按前缀校验，确保 manifest 不是只列了几个入口文件。 */
export function officeViewerRequiredAssetPrefixes(kinds: readonly string[]): string[] {
  return kinds.includes("pdf")
    ? [
        "dist/ui/fonts/",
        "dist/ui/pdfjs/cmaps/",
        "dist/ui/pdfjs/standard_fonts/",
        "dist/ui/pdfjs/wasm/",
      ]
    : [];
}

/**
 * 从插件 `package.json` 的 office profile 读 kinds（纯数据）。
 * 构建期 staging 与运行期 seed 共用同一条读取规则，避免两边对 profile 形状理解不一致。
 */
export function officeViewerKindsFromPackageManifest(raw: unknown): string[] {
  const kinds = (raw as { office?: { kinds?: unknown } } | null | undefined)?.office?.kinds;
  return Array.isArray(kinds)
    ? kinds.filter((kind): kind is string => typeof kind === "string")
    : [];
}

/**
 * manifest 与 seed 文件集的纯闭包比对：manifest 声明的每个资源都必须在文件集中出现，
 * 且大小/哈希不得漂移（文件集没提供的维度不猜）。
 *
 * 这是 filesystem seed、SEA seed 与缓存目录共用的同一份闭包规则；返回首个不一致项，
 * 全部通过返回 null，调用方在写/激活缓存前 fail closed。
 */
export function findOfficeViewerAssetSeedClosureMismatch(input: {
  files: readonly OfficeViewerAssetSeedFile[];
  kinds: readonly string[];
  rawManifest: unknown;
}): OfficeViewerAssetSeedMismatch | null {
  let manifest: OfficeViewerAssetManifest;
  try {
    manifest = parseOfficeViewerAssetManifest(input.rawManifest);
    assertOfficeViewerAssetManifest(manifest, input.kinds);
  } catch (error) {
    // 闭包/结构错误指向 manifest 本身：具体缺哪个资源由 reason 带出。
    return {
      path: OFFICE_VIEWER_ASSET_MANIFEST_PATH,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const seedFiles = new Map<string, OfficeViewerAssetSeedFile>();
  for (const file of input.files) {
    if (seedFiles.has(file.path)) return { path: file.path, reason: "duplicate seed asset" };
    seedFiles.set(file.path, file);
  }
  for (const file of manifest.files) {
    const seedFile = seedFiles.get(file.path);
    if (!seedFile) return { path: file.path, reason: "declared asset is missing from the seed" };
    if (seedFile.sha256 !== undefined && seedFile.sha256 !== file.sha256)
      return { path: file.path, reason: "seed asset hash does not match the manifest" };
    if (seedFile.bytes !== undefined && seedFile.bytes !== file.bytes)
      return { path: file.path, reason: "seed asset size does not match the manifest" };
  }
  return null;
}

/** 纯闭包校验：入口、字体分片、worker/wasm、NOTICE 与安全路径全部通过才算完整。 */
export function assertOfficeViewerAssetManifest(
  manifest: OfficeViewerAssetManifest,
  kinds: readonly string[],
): void {
  const files = new Set(manifest.files.map((file) => file.path));
  for (const required of officeViewerRequiredAssetPaths(kinds))
    if (!files.has(required))
      throw new Error(`Office viewer manifest is missing required asset: ${required}`);
  for (const prefix of officeViewerRequiredAssetPrefixes(kinds)) {
    if (!manifest.files.some((file) => file.path.startsWith(prefix)))
      throw new Error(`Office viewer manifest is missing required asset dir: ${prefix}`);
  }
  if (kinds.includes("pdf")) {
    const slices = manifest.files.filter((file) => file.path.startsWith("dist/ui/fonts/")).length;
    if (slices !== OFFICE_VIEWER_PDF_FONT_SLICE_COUNT)
      throw new Error(
        `Office viewer manifest has ${slices} font slices, expected ${OFFICE_VIEWER_PDF_FONT_SLICE_COUNT}`,
      );
  }
  // scripts 是面板加载入口，必须与文件清单一致，不能出现“有文件但面板不加载”的漂移。
  for (const script of manifest.scripts) {
    const path = `dist/ui/${script}`;
    if (!files.has(path)) throw new Error(`Office viewer manifest is missing script: ${path}`);
  }
}
