import { readFile } from "node:fs/promises";
import { z } from "zod";

export const EXPECTED_ZOD_VERSION = "4.6.5";
export const trimPathAllowlist = new Set([
  "envelope.baseLogEpoch",
  "createSession.firstInput.modelSelection.providerId",
  "createSession.firstInput.modelSelection.modelId",
  "createSession.firstInput.modelSelection.options.reasoningLevel",
  "createSession.config.modelSelection.providerId",
  "createSession.config.modelSelection.modelId",
  "createSession.config.modelSelection.options.reasoningLevel",
  "createSession.mcpServers[].name",
  "createSession.mcpServers[].command",
  "createSession.mcpServers[].env[].name",
  "createSession.mcpServers[].url",
  "createSession.mcpServers[].headers[].name",
  "createSession.mcpServers[].oauth.clientId",
  "createSession.mcpServers[].oauth.clientSecret",
  "createSession.mcpServers[].oauth.clientName",
  "createSession.mcpServers[].oauth.redirectPath",
  "createSelectionSideSession.firstInput.text",
  "createSelectionSideSession.firstInput.modelSelection.providerId",
  "createSelectionSideSession.firstInput.modelSelection.modelId",
  "createSelectionSideSession.firstInput.modelSelection.options.reasoningLevel",
  "sendText.browserAmbientContext.currentUrl",
  "sendText.context_refs[].context_id",
  "sendText.modelSelection.providerId",
  "sendText.modelSelection.modelId",
  "sendText.modelSelection.options.reasoningLevel",
  "sendText.botDeliveryTarget.botId",
  "sendText.botDeliveryTarget.providerUserId",
  "sendGoalCommand.modelSelection.providerId",
  "sendGoalCommand.modelSelection.modelId",
  "sendGoalCommand.modelSelection.options.reasoningLevel",
  ...["forkAssistant", "applyFileRewind", "editUserQuery", "retryTurn", "setAssistantFeedback"].map(
    (kind) => `${kind}.target.entityId`,
  ),
  ...[
    "respondWorkspaceHookReview",
    "toggleWorkspaceHookReviewItem",
    "revokeWorkspaceHookTrust",
    "requestWorkspaceHookReview",
  ].flatMap((kind) =>
    [
      "sessionId",
      "taskId",
      "runId",
      "remoteSessionId",
      "workspaceIdentity",
      "reviewFlowId",
      "interactionId",
    ]
      .filter(
        (field) =>
          kind !== "requestWorkspaceHookReview" ||
          ["sessionId", "remoteSessionId", "workspaceIdentity"].includes(field),
      )
      .map((field) => `${kind}.${field}`),
  ),
  "respondWorkspaceHookReview.decision.reviewItemIds[]",
  "toggleWorkspaceHookReviewItem.reviewItemId",
  "revokeWorkspaceHookTrust.reviewItemIds[]",
  "discardSharedContext.contextId",
]);

export function inventory(
  schema,
  path,
  state = { transformInventory: new Set(), trimLeaves: [] },
  seen = new Set(),
) {
  if (!schema?._zod || seen.has(schema)) return state.transformInventory;
  seen.add(schema);
  const def = schema._zod.def;
  const supportedTypes = new Set([
    "array",
    "boolean",
    "enum",
    "literal",
    "nullable",
    "number",
    "object",
    "optional",
    "record",
    "string",
    "union",
    "unknown",
  ]);
  if (!supportedTypes.has(def.type))
    throw new Error(`Unsupported Zod schema type ${def.type} at ${path}`);
  const overwrites = (def.checks ?? []).filter((check) => check?._zod?.def?.check === "overwrite");
  if (overwrites.length && (def.type !== "string" || overwrites.length !== 1))
    throw new Error(
      `Unsupported overwrite inventory at ${path}: expected exactly one string overwrite`,
    );
  if (overwrites.length) {
    const check = overwrites[0];
    const extension = check?._zod?.def?.["x-zcode-trim"];
    if (extension !== undefined && extension !== true)
      throw new Error(`Unsupported overwrite extension at ${path}: expected x-zcode-trim: true`);
    state.transformInventory.add(path);
    state.trimLeaves.push({ path, zodSchema: schema });
  }
  for (const check of def.checks ?? []) {
    const kind = check?._zod?.def?.check;
    if (
      typeof kind !== "string" ||
      ![
        "overwrite",
        "min_length",
        "max_length",
        "regex",
        "string_format",
        "less_than",
        "greater_than",
        "number_format",
        "custom",
      ].includes(kind)
    ) {
      throw new Error(`Unsupported Zod check ${String(kind)} at ${path}`);
    }
  }
  if (def.shape)
    for (const [key, child] of Object.entries(def.shape))
      inventory(child, `${path}.${key}`, state, seen);
  if (def.innerType) inventory(def.innerType, path, state, seen);
  if (def.element) inventory(def.element, `${path}[]`, state, seen);
  if (def.options) for (const child of def.options) inventory(child, path, state, seen);
  if (def.valueType) inventory(def.valueType, `${path}.*`, state, seen);
  if (def.keyType) inventory(def.keyType, `${path}.<key>`, state, seen);
  seen.delete(schema);
  return state.transformInventory;
}

export function assertAllowlist(transforms, allowlist = trimPathAllowlist) {
  const unlisted = [...transforms].filter((path) => !allowlist.has(path));
  const stale = [...allowlist].filter((path) => !transforms.has(path));
  if (unlisted.length || stale.length)
    throw new Error(
      `Trim inventory mismatch; unlisted: ${unlisted.join(", ") || "none"}; stale: ${stale.join(", ") || "none"}`,
    );
}

export function toSchema(schema) {
  return z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "throw",
    override({ zodSchema, jsonSchema }) {
      for (const check of zodSchema?._zod?.def?.checks ?? []) {
        const kind = check?._zod?.def?.check;
        if (kind === "overwrite") {
          const extension = check?._zod?.def?.["x-zcode-trim"];
          if (extension !== undefined && extension !== true)
            throw new Error("Unsupported overwrite extension; expected x-zcode-trim: true");
          jsonSchema["x-zcode-trim"] = true;
        }
      }
    },
  });
}

export async function assertPinnedZod(
  packageUrl = new URL("../../node_modules/zod/package.json", import.meta.url),
) {
  const pkg = JSON.parse(await readFile(packageUrl, "utf8"));
  if (pkg.version !== EXPECTED_ZOD_VERSION)
    throw new Error(`Expected Zod ${EXPECTED_ZOD_VERSION}, found ${pkg.version}`);
}
