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
