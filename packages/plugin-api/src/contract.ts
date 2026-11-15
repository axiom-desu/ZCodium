/**
 * plugin-api 的受管契约入口：把面向插件作者的稳定公开导出集中到一处，
 * 真实定义仍在 `@zcode/shared/extension-host`，这里不增加运行时。
 */
export type {
  CapabilityId,
  CapabilityInput,
  CapabilityOutput,
  ExtensionCapabilityTable,
  ExtensionGrant,
  ExtensionManifest,
  ExtensionProtocols,
  ExtensionSlotContribution,
  ExtensionSlotIcon,
  ExtensionSlotId,
  ManifestErrorCode,
  ManifestValidation,
} from "@zcode/shared/extension-host";
export type {
  ExtensionActivate,
  ExtensionContext,
  ExtensionHostClient,
  ExtensionHostError,
  ExtensionSessionsContext,
} from "@zcode/shared/extension-host/sdk";
export { defineExtension } from "@zcode/shared/extension-host/sdk";
export { validateExtensionManifest } from "@zcode/shared/extension-host";
