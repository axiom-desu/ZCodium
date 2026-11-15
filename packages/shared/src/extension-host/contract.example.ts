import type { ExtensionManifest } from "./manifest.js";
import { validateExtensionManifest } from "./manifest.js";
import { normalizeGrants } from "./grants.js";

/** 一份通过校验的最小清单。 */
export const exampleExtensionManifestInput = {
  schemaVersion: 1,
  id: "example-extensions",
  name: "Example Extensions",
  version: "1.0.0",
  main: "extension.mjs",
  capabilities: ["settings.get", "projects.list", "context.get"],
  grants: ["projects.read"],
  protocols: { projects: 1 },
  slots: [{ id: "nav-projects", slot: "navigation.primary", title: "Projects", icon: "list" }],
} as const;

const validated = validateExtensionManifest(exampleExtensionManifestInput);
if (!validated.ok) throw new Error("example extension manifest must validate");
export const exampleExtensionManifest: ExtensionManifest = validated.manifest;
export const exampleNormalizedGrants = normalizeGrants(exampleExtensionManifest.grants);

/**
 * 声明会话读能力的清单：只声明 sessions.write 也满足四个读（write 包含 read）。
 * 写入档位只在这里出现，用户授权对话框直接展示它。
 */
export const exampleSessionExtensionManifestInput = {
  schemaVersion: 1,
  id: "example-sessions",
  name: "Example Sessions",
  version: "1.0.0",
  main: "extension.mjs",
  capabilities: ["sessions.listProjects", "sessions.listSessions", "sessions.readSession"],
  grants: ["sessions.write"],
  protocols: { sessions: 1 },
  slots: [],
} as const;

const validatedSession = validateExtensionManifest(exampleSessionExtensionManifestInput);
if (!validatedSession.ok) throw new Error("example session extension manifest must validate");
export const exampleSessionExtensionManifest: ExtensionManifest = validatedSession.manifest;
