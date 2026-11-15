import { z } from "zod";
import {
  EXTENSION_CAPABILITIES,
  getCapabilityDef,
  isCapabilityId,
  type CapabilityId,
} from "./capabilities.js";
import {
  extensionSlotContributionSchema,
  EXTENSION_MAX_SLOTS_PER_PLUGIN,
} from "./contributions.js";
import {
  extensionGrantSchema,
  extensionProtocolsSchema,
  grantsCover,
  type ExtensionGrant,
  type ExtensionProtocols,
} from "./grants.js";

/**
 * 扩展清单：严格、有界。未知键一律拒绝，避免扩展用未审阅字段描述 UI 或权限。
 * 清单只声明能力与档位，不携带 HTML、脚本路径之外的运行参数。
 */
export const EXTENSION_MANIFEST_SCHEMA_VERSION = 1;
export const EXTENSION_MAX_MANIFEST_BYTES = 64 * 1024;
export const EXTENSION_MAX_DECLARED_CAPABILITIES = 32;

export const extensionManifestSchema = z.strictObject({
  schemaVersion: z.literal(EXTENSION_MANIFEST_SCHEMA_VERSION),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  name: z.string().min(1).max(200),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  /** 扩展进程内加载的模块文件；只允许同目录下的单层相对文件名。 */
  main: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.(?:mjs|js)$/),
  capabilities: z.array(z.string().min(1).max(64)).max(EXTENSION_MAX_DECLARED_CAPABILITIES),
  grants: z.array(extensionGrantSchema).max(16).default([]),
  protocols: extensionProtocolsSchema.default({}),
  slots: z.array(extensionSlotContributionSchema).max(EXTENSION_MAX_SLOTS_PER_PLUGIN).default([]),
});
export type ExtensionManifest = z.infer<typeof extensionManifestSchema>;

export type ManifestValidation =
  | { ok: true; manifest: ExtensionManifest }
  | { ok: false; code: ManifestErrorCode; message: string };

export type ManifestErrorCode =
  | "invalid-manifest"
  | "unknown-capability"
  | "undeclared-grant"
  | "duplicate-slot";

/**
 * 校验清单并把「能力 → 档位 → 授权声明」对齐。
 *
 * - 能力必须在宿主能力表里存在，否则 `unknown-capability`（不是静默忽略）。
 * - 能力需要的档位必须在 `grants` 里声明，否则 `undeclared-grant`：避免插件调用时才暴露权限。
 * - 槽位 id 在插件内唯一。
 */
export function validateExtensionManifest(input: unknown): ManifestValidation {
  const parsed = extensionManifestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "invalid-manifest", message: "Extension manifest is not valid." };
  }
  const manifest = parsed.data;

  for (const capabilityId of manifest.capabilities) {
    if (!isCapabilityId(capabilityId)) {
      return {
        ok: false,
        code: "unknown-capability",
        message: `Unknown extension capability: ${capabilityId}`,
      };
    }
    const def = getCapabilityDef(capabilityId);
    if (def && !grantsCover(manifest.grants, def.grant)) {
      return {
        ok: false,
        code: "undeclared-grant",
        message: `Capability ${capabilityId} requires grant ${def.grant}.`,
      };
    }
  }

  const slotIds = new Set<string>();
  for (const slot of manifest.slots) {
    if (slotIds.has(slot.id)) {
      return { ok: false, code: "duplicate-slot", message: `Duplicate slot id: ${slot.id}` };
    }
    slotIds.add(slot.id);
  }

  return { ok: true, manifest };
}

/** 清单声明的有效能力（去重且只保留能力表里存在的项）。 */
export function declaredCapabilityIds(manifest: ExtensionManifest): CapabilityId[] {
  return [...new Set(manifest.capabilities)].filter(isCapabilityId);
}

/** 清单展示用名称；名称只进入 UI 文本，不进入路径或日志自由格式。 */
export function describeManifest(manifest: ExtensionManifest): {
  id: string;
  name: string;
  version: string;
  grants: ExtensionGrant[];
  protocols: ExtensionProtocols;
  capabilities: readonly string[];
} {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    grants: manifest.grants,
    protocols: manifest.protocols,
    capabilities: Object.keys(EXTENSION_CAPABILITIES).filter((id) =>
      manifest.capabilities.includes(id),
    ),
  };
}
