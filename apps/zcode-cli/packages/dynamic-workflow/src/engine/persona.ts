/**
 * persona 规范化。从 engine.ts 拆出（oxlint max-lines 400 行门）；公开面不变——它只被
 * {@link import("./engine.js").WorkflowEngine.createActor} 调用。
 */

import type { PersonaSpec } from "./types.js";

/** persona 规范化：字符串视为 system prompt；display name 落到 persona.name。 */
export function normalizePersona(
  name: string | undefined,
  persona: string | PersonaSpec | undefined,
): PersonaSpec {
  const base: PersonaSpec =
    typeof persona === "string" ? { system: persona } : persona ? { ...persona } : {};
  if (base.name === undefined && name !== undefined) base.name = name;
  return base;
}
