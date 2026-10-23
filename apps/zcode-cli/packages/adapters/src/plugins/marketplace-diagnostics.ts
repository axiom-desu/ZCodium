import { join } from "node:path";
import type { PluginDiagnostic, PluginManifest } from "@zcode/contracts";
import { isRecord, sanitizePluginId } from "./helpers.js";
import { loadPluginMcpServerDefinitions, resolvePluginMcpServers } from "./mcp.js";
import {
  SOURCE_SHA256_PATTERN,
  UNSUPPORTED_MANIFEST_FIELDS,
  UnsupportedMarketplaceSourceError,
  UnsupportedPluginSourceError,
  type PluginMarketplaceEntry,
  type PluginValidationDiagnostic,
  createManifestFromMarketplaceEntry,
} from "./marketplace-types.js";
import { readPluginManifestFromRoot } from "./marketplace-manifest.js";
import {
  readOptionalZipPluginSourcePath,
  readOptionalZipPluginSourceStripRoot,
  readPluginSourceHeaders,
  readRequiredPluginSourceString,
  readRequiredZipPluginSourceSha256,
} from "./marketplace-source.js";
import { getPluginSourceDiagnosticCode } from "./source-errors.js";

export function validatePluginRoot(input: {
  entry: PluginMarketplaceEntry;
  marketplace: string;
  rootPath: string;
  storageRoot: string;
}): PluginValidationDiagnostic[] {
  const diagnostics: PluginValidationDiagnostic[] = [];
  const pluginId = `${input.entry.name}@${input.marketplace}`;
  let loadedManifest: { manifest: PluginManifest; manifestPath?: string } | null = null;
  try {
    loadedManifest = readPluginManifestFromRoot(input.rootPath, input.entry);
  } catch (error) {
    diagnostics.push({
      code: "plugin_manifest_invalid",
      message: error instanceof Error ? error.message : String(error),
      path: input.rootPath,
      pluginId,
      severity: "error",
    });
    return diagnostics;
  }

  if (!loadedManifest) {
    diagnostics.push({
      code: "plugin_manifest_not_found",
      message: `Plugin manifest not found: ${pluginId}`,
      path: input.rootPath,
      pluginId,
      severity: "error",
    });
    return diagnostics;
  }

  const manifestPath = loadedManifest.manifestPath ?? input.rootPath;
  if (loadedManifest.manifest.name !== input.entry.name) {
    diagnostics.push({
      code: "plugin_manifest_invalid",
      message: `Plugin manifest name '${loadedManifest.manifest.name}' does not match marketplace entry '${input.entry.name}'`,
      path: manifestPath,
      pluginId,
      severity: "error",
    });
  }
  pushManifestCompatibilityDiagnostics({
    diagnostics,
    manifest: loadedManifest.manifest,
    manifestPath,
    pluginId,
    source: "cache",
  });
  pushMcpValidationDiagnostics({
    diagnostics,
    manifest: loadedManifest.manifest,
    manifestPath,
    marketplace: input.marketplace,
    pluginId,
    rootPath: input.rootPath,
    storageRoot: input.storageRoot,
  });
  return diagnostics;
}

function pushManifestCompatibilityDiagnostics(input: {
  diagnostics: PluginValidationDiagnostic[];
  manifest: PluginManifest;
  manifestPath: string;
  pluginId: string;
  source: "cache" | "inline" | "official";
}): void {
  for (const key of UNSUPPORTED_MANIFEST_FIELDS) {
    if (key in input.manifest) {
      input.diagnostics.push({
        code: "plugin_unsupported_component",
        message: `Plugin component is diagnostic-only in this ZCode runtime: ${key}`,
        path: input.manifestPath,
        pluginId: input.pluginId,
        severity: "warning",
      });
    }
  }
  for (const [key, option] of Object.entries(input.manifest.userConfig ?? {})) {
    if (option.required === true && option.default === undefined) {
      input.diagnostics.push({
        code: "plugin_variable_missing",
        message: `Required plugin userConfig has no default and must be configured: ${key}`,
        path: input.manifestPath,
        pluginId: input.pluginId,
        severity: "warning",
      });
    }
  }
  if (containsMcpBundleSource(input.manifest.mcpServers)) {
    input.diagnostics.push({
      code: "plugin_marketplace_source_unsupported",
      message: "MCPB/DXT plugin bundles are recognized but not supported in this runtime",
      path: input.manifestPath,
      pluginId: input.pluginId,
      severity: "warning",
    });
  }
}

function pushMcpValidationDiagnostics(input: {
  diagnostics: PluginValidationDiagnostic[];
  manifest: PluginManifest;
  manifestPath: string;
  marketplace: string;
  pluginId: string;
  rootPath: string;
  storageRoot: string;
}): void {
  const diagnostics = input.diagnostics as PluginDiagnostic[];
  const loaded = {
    id: input.pluginId,
    manifest: input.manifest,
    manifestPath: input.manifestPath,
    marketplace: input.marketplace,
    rootPath: input.rootPath,
    source: "cache" as const,
  };
  const definitions = loadPluginMcpServerDefinitions({ diagnostics, loaded });
  resolvePluginMcpServers({
    dataPath: join(input.storageRoot, "data", sanitizePluginId(input.pluginId)),
    definitions,
    diagnostics,
    env: {},
    loaded,
    options: {},
    workingDirectory: process.cwd(),
  });
}

function containsMcpBundleSource(value: unknown): boolean {
  if (typeof value === "string") return value.endsWith(".mcpb") || value.endsWith(".dxt");
  if (Array.isArray(value)) return value.some(containsMcpBundleSource);
  return false;
}

export function validateMarketplaceEntryShape(
  entry: PluginMarketplaceEntry,
  marketplace: string,
  options: { includeEntryCompatibility?: boolean } = {},
): PluginValidationDiagnostic[] {
  const diagnostics: PluginValidationDiagnostic[] = [];
  const pluginId = `${entry.name}@${marketplace}`;
  if (entry.source === undefined) {
    diagnostics.push({
      code: "plugin_marketplace_invalid",
      message: `Plugin has no install source: ${pluginId}`,
      pluginId,
      severity: "error",
    });
  }
  if (isRecord(entry.source)) {
    const sourceKind = typeof entry.source.source === "string" ? entry.source.source : "";
    if (sourceKind === "npm" || sourceKind === "pip") {
      diagnostics.push({
        code: "plugin_marketplace_source_unsupported",
        message: `Plugin source is recognized but not supported in V1 install: ${sourceKind}`,
        pluginId,
        severity: "warning",
      });
    }
    if (sourceKind === "url") {
      const sourceType = typeof entry.source.type === "string" ? entry.source.type : "";
      if (sourceType && sourceType !== "git" && sourceType !== "zip") {
        diagnostics.push({
          code: "plugin_marketplace_source_unsupported",
          message: `Plugin URL source type is not supported: ${sourceType}`,
          pluginId,
          severity: "error",
        });
      }
      try {
        readRequiredPluginSourceString(entry.source, "url", "URL");
        if (sourceType === "zip") {
          const sha256 = readRequiredZipPluginSourceSha256(entry.source).toLowerCase();
          if (!SOURCE_SHA256_PATTERN.test(sha256)) {
            throw new Error("Plugin zip source sha256 must be a 64 character hex string");
          }
          readPluginSourceHeaders(entry.source);
          readOptionalZipPluginSourcePath(entry.source);
          readOptionalZipPluginSourceStripRoot(entry.source);
        }
      } catch (error) {
        diagnostics.push({
          code: "plugin_marketplace_invalid",
          message: error instanceof Error ? error.message : String(error),
          pluginId,
          severity: "error",
        });
      }
    }
  }
  if (options.includeEntryCompatibility !== false) {
    pushEntryCompatibilityDiagnostics({ diagnostics, entry, marketplace });
  }
  return diagnostics;
}

export function pushEntryCompatibilityDiagnostics(input: {
  diagnostics: PluginValidationDiagnostic[];
  entry: PluginMarketplaceEntry;
  marketplace: string;
}): void {
  const pluginId = `${input.entry.name}@${input.marketplace}`;
  pushManifestCompatibilityDiagnostics({
    diagnostics: input.diagnostics,
    manifest: createManifestFromMarketplaceEntry(input.entry) as unknown as PluginManifest,
    manifestPath: pluginId,
    pluginId,
    source: "cache",
  });
}

export function getMarketplaceSourceValidationDeferral(
  entry: PluginMarketplaceEntry,
  marketplace: string,
): PluginValidationDiagnostic | null {
  if (!isRecord(entry.source)) return null;
  const sourceKind = typeof entry.source.source === "string" ? entry.source.source : "";
  if (sourceKind === "url") {
    const sourceType = typeof entry.source.type === "string" ? entry.source.type : "";
    if (sourceType && sourceType !== "git" && sourceType !== "zip") return null;
  }
  if (!["github", "git", "url", "git-subdir"].includes(sourceKind)) return null;
  const pluginId = `${entry.name}@${marketplace}`;
  const sourceLabel =
    typeof entry.source.repo === "string"
      ? entry.source.repo
      : typeof entry.source.url === "string"
        ? entry.source.url
        : sourceKind;
  return {
    code: "plugin_validation_deferred",

    // 聚合市场可能包含大量外部 git source；市场级 validate 不逐个 clone，单插件安装或校验时
    // 再深扫目标 root，避免设置页被网络操作拖到协议超时。
    message: `Remote plugin source validation is deferred until install or single-plugin validate: ${sourceLabel}`,
    pluginId,
    severity: "warning",
  };
}

export function toValidationDiagnostic(
  error: unknown,
  pluginId?: string,
): PluginValidationDiagnostic {
  if (
    error instanceof UnsupportedMarketplaceSourceError ||
    error instanceof UnsupportedPluginSourceError
  ) {
    return {
      code: "plugin_marketplace_source_unsupported",
      message: error.message,
      ...(pluginId ? { pluginId } : {}),
      severity: "error",
    };
  }
  const sourceCode = getPluginSourceDiagnosticCode(error);
  if (sourceCode) {
    return {
      code: sourceCode,
      message: error instanceof Error ? error.message : String(error),
      ...(pluginId ? { pluginId } : {}),
      severity: "error",
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Cross-marketplace dependency")) {
    return {
      code: "plugin_dependency_cross_marketplace",
      message,
      ...(pluginId ? { pluginId } : {}),
      severity: "error",
    };
  }
  if (message.includes("dependency cycle")) {
    return {
      code: "plugin_dependency_cycle",
      message,
      ...(pluginId ? { pluginId } : {}),
      severity: "error",
    };
  }
  if (
    message.includes("Dependency not found") ||
    message.includes("Marketplace not found for dependency")
  ) {
    return {
      code: "plugin_dependency_missing",
      message,
      ...(pluginId ? { pluginId } : {}),
      severity: "error",
    };
  }
  return {
    code: "plugin_marketplace_invalid",
    message,
    ...(pluginId ? { pluginId } : {}),
    severity: "error",
  };
}
