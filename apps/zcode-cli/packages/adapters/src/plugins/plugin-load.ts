import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginDiagnostic, PluginManifest } from "@zcode/contracts";
import { directoryExists, fileExists, isRecord, throwIfAborted } from "./helpers.js";
import type { LoadedPlugin, PluginAbortOptions, PluginCandidate } from "./types.js";
import { loadBundledOfficialPluginRootsSync } from "./official-marketplace.js";

const ZCODE_MANIFEST_PATH = join(".zcodium-plugin", "plugin.json");
const CLAUDE_MANIFEST_PATH = join(".claude-plugin", "plugin.json");
const CODEX_MANIFEST_PATH = join(".codex-plugin", "plugin.json");
const DEFAULT_VERSION = "0.0.0";
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export function scanOfficialCache(storageRoot: string, options?: PluginAbortOptions): string[] {
  // 旧目录扫描会在 seed 缺失时把历史缓存误当内置插件复活；只有随包清单能授权隐式发现。
  // 用户显式安装的记录仍在 resolveCandidates 的 installed 分支独立处理。
  throwIfAborted(options);
  return loadBundledOfficialPluginRootsSync(storageRoot) ?? [];
}

export function loadPlugin(
  candidate: PluginCandidate,
  diagnostics: PluginDiagnostic[],
): LoadedPlugin | null {
  if (!directoryExists(candidate.rootPath)) {
    diagnostics.push({
      code: "plugin_root_not_found",
      message: `Plugin root does not exist: ${candidate.rootPath}`,
      path: candidate.rootPath,
      severity: "warning",
    });
    return null;
  }

  const manifestPath = findManifest(candidate.rootPath);
  if (!manifestPath) {
    diagnostics.push({
      code: "plugin_manifest_not_found",
      message: `Plugin manifest not found: ${candidate.rootPath}`,
      path: candidate.rootPath,
      severity: "error",
    });
    return null;
  }

  const manifest = readManifest(manifestPath, diagnostics);
  if (!manifest) return null;
  return {
    id: `${manifest.name}@${candidate.marketplace}`,
    manifest,
    manifestPath,
    marketplace: candidate.marketplace,
    rootPath: candidate.rootPath,
    source: candidate.source,
  };
}

function findManifest(rootPath: string): string | null {
  const zcodePath = join(rootPath, ZCODE_MANIFEST_PATH);
  if (fileExists(zcodePath)) {
    return zcodePath;
  }

  // 兼容不同 manifest 目录约定，发现阶段按稳定优先级回退。
  const claudePath = join(rootPath, CLAUDE_MANIFEST_PATH);
  if (fileExists(claudePath)) {
    return claudePath;
  }
  const codexPath = join(rootPath, CODEX_MANIFEST_PATH);
  return fileExists(codexPath) ? codexPath : null;
}

function readManifest(path: string, diagnostics: PluginDiagnostic[]): PluginManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("Manifest must be a JSON object");
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!PLUGIN_NAME_PATTERN.test(name)) throw new Error(`Invalid plugin name: ${name}`);
    return {
      ...parsed,
      name,
      version: typeof parsed.version === "string" ? parsed.version : DEFAULT_VERSION,
    } as PluginManifest;
  } catch (error) {
    diagnostics.push({
      code: "plugin_manifest_invalid",
      message: error instanceof Error ? error.message : `Invalid plugin manifest: ${path}`,
      path,
      severity: "error",
    });
    return null;
  }
}
