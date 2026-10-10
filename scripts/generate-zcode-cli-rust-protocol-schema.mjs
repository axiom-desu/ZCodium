// Run with node --import tsx. Export schema and differential oracle fixtures from
// the repository's TypeScript Zod command contract.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { format } from "oxfmt";
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  ROW_TARGETING_COMMANDS,
  commandAckSchema,
  commandEnvelopeSchema,
  commandPayloadSchemas,
  parseCommandEnvelope,
} from "../packages/shared/src/zcode-protocol-v4/command.ts";
import {
  assertAllowlist,
  assertPinnedZod,
  inventory,
  toSchema,
  trimPathAllowlist,
} from "./lib/zcodeCliRustCommandTransforms.mjs";

await assertPinnedZod(new URL("../node_modules/zod/package.json", import.meta.url));
const inventoryState = { transformInventory: new Set(), trimLeaves: [] };
inventory(commandEnvelopeSchema, "envelope", inventoryState);
for (const [kind, schema] of Object.entries(commandPayloadSchemas))
  inventory(schema, kind, inventoryState);
assertAllowlist(inventoryState.transformInventory, trimPathAllowlist);
const branchOrdinals = new Map();
const trimCases = [" \uFEFFAbC\u00A0 ", " \t\uFEFF\u00A0\n ", "a  B", "AbC", "\u00A0AbC\uFEFF"];
const trimOracle = {
  uniquePaths: inventoryState.transformInventory.size,
  leafBranches: inventoryState.trimLeaves.length,
  leaves: inventoryState.trimLeaves.map(({ path, zodSchema }) => {
    const branch = (branchOrdinals.get(path) ?? 0) + 1;
    branchOrdinals.set(path, branch);
    return {
      path,
      branch,
      schema: toSchema(zodSchema),
      cases: trimCases.map((raw) => {
        const result = zodSchema.safeParse(raw);
        return {
          raw,
          ok: result.success,
          ...(result.success ? { parsed: result.data } : {}),
        };
      }),
    };
  }),
};
const data = {
  envelope: toSchema(commandEnvelopeSchema),
  payloads: Object.fromEntries(
    Object.keys(commandPayloadSchemas)
      .sort()
      .map((type) => [type, toSchema(commandPayloadSchemas[type])]),
  ),
  requiresBaseRevision: [...COMMANDS_REQUIRING_BASE_REVISION].sort(),
  requiresBaseLogEpoch: [...ROW_TARGETING_COMMANDS].sort(),
};
const root = new URL("../apps/zcode-cli-rust/crates/protocol/", import.meta.url);
const cases = [];
const makeCommand = ({
  commandId = "command-1",
  payload = { text: "hello" },
  ttft,
  ...extra
} = {}) => ({
  commandId,
  clientId: "client-1",
  sessionId: "session-1",
  type: "sendText",
  payload,
  issuedAt: 1,
  ...(ttft === undefined ? {} : { ttft }),
  ...extra,
});
const addCommand = (name, command, decimalIssuedAt = false) => {
  const serialized = JSON.stringify(command);
  const raw = decimalIssuedAt ? serialized.replace('"issuedAt":1', '"issuedAt":1.0') : serialized;
  const result = parseCommandEnvelope(JSON.parse(raw));
  cases.push({ name, raw, ok: result.ok, ...(result.ok ? { parsed: result.envelope } : {}) });
};
for (const [name, observationId] of [
  ["uuid-nil", "00000000-0000-0000-0000-000000000000"],
  ["uuid-max", "ffffffff-ffff-ffff-ffff-ffffffffffff"],
  ["uuid-ordinary", "01890a5d-ac96-774b-bcce-b302099a8057"],
  ["uuid-invalid", "01890a5d-ac96-074b-bcce-b302099a8057"],
  ["uuid-braces", "{01890a5d-ac96-774b-bcce-b302099a8057}"],
  ["uuid-unicode", "😀1890a5d-ac96-774b-bcce-b302099a8057"],
]) {
  addCommand(name, makeCommand({ ttft: { version: 1, observationId } }));
}
addCommand("send-text-offpeak-command-id", makeCommand({ commandId: "offpeak-legacy" }));
addCommand(
  "send-text-offpeak-command-id-whitespace",
  makeCommand({ commandId: "  offpeak-legacy  " }),
);
addCommand("send-text-command-id-whitespace", makeCommand({ commandId: "  command-1  " }));
addCommand("json-number-integer-literal", { ...makeCommand(), issuedAt: 1 });
addCommand("json-number-decimal-literal", { ...makeCommand(), issuedAt: 1 }, true);
for (const [name, rawNumber] of [
  ["base-revision-one", "1"],
  ["base-revision-one-decimal", "1.0"],
  ["base-revision-negative", "-1"],
  ["base-revision-fractional", "1.5"],
]) {
  const command = {
    ...makeCommand({ payload: { mode: "queue" } }),
    type: "setFollowupMode",
    baseRevision: 1,
  };
  const serialized = JSON.stringify(command).replace(
    '"baseRevision":1',
    `"baseRevision":${rawNumber}`,
  );
  const result = parseCommandEnvelope(JSON.parse(serialized));
  cases.push({
    name,
    raw: serialized,
    ok: result.ok,
    ...(result.ok ? { parsed: result.envelope } : {}),
  });
}
addCommand(
  "create-session-strip-unknown",
  makeCommand({
    payload: {
      workspaceId: "workspace",
      unexpected: true,
      config: { mode: "build", ignored: true },
    },
    type: "createSession",
  }),
);
addCommand("send-text-strict", makeCommand({ payload: { text: "hello", extra: true } }));
addCommand(
  "send-text-model-execution-without-selection",
  makeCommand({
    payload: { text: "hello", modelExecution: { selectionScope: "execution" } },
  }),
);
addCommand(
  "send-text-off-peak-refinement",
  makeCommand({
    payload: { text: "hello", toolDisallowlist: ["OffPeakCreate"] },
  }),
);
addCommand("cas-missing-base-revision", {
  ...makeCommand({ payload: { mode: "queue" } }),
  type: "setFollowupMode",
});
addCommand("cas-with-base-revision", {
  ...makeCommand({ payload: { mode: "queue" } }),
  type: "setFollowupMode",
  baseRevision: 7,
});
addCommand(
  "optional-fields-preserved",
  makeCommand({
    ttft: { version: 1, observationId: "01890a5d-ac96-774b-bcce-b302099a8057" },
    baseRevision: 9,
    baseLogEpoch: "epoch-1",
  }),
);
addCommand("base-log-epoch-padded", makeCommand({ baseLogEpoch: "  epoch-1  " }));
addCommand("base-log-epoch-null", makeCommand({ baseLogEpoch: null }));
addCommand("base-log-epoch-only-whitespace", makeCommand({ baseLogEpoch: "  \uFEFF\u00A0  " }));
addCommand(
  "side-session-first-input-trim",
  makeCommand({
    type: "createSelectionSideSession",
    payload: { firstInput: { text: "  hello  " } },
  }),
);
addCommand(
  "send-text-model-and-browser-context",
  makeCommand({
    payload: {
      text: "  preserve text  ",
      modelSelection: { providerId: " p ", modelId: " m ", options: { reasoningLevel: " deep " } },
      browserAmbientContext: { tabCount: 1, currentUrl: " https://example.invalid/path " },
      context_refs: [{ kind: "shared_context_import", context_id: " ref-1 " }],
    },
  }),
);
addCommand(
  "workspace-hook-review-trimmed-identifiers",
  makeCommand({
    type: "respondWorkspaceHookReview",
    payload: {
      sessionId: " session ",
      taskId: " task ",
      runId: " run ",
      workspaceIdentity: " identity ",
      bundleDigest: "a".repeat(64),
      reviewFlowId: " flow ",
      generation: 1,
      interactionId: " interaction ",
      decision: { action: "trust_selected", reviewItemIds: [" item-1 "] },
    },
  }),
);
addCommand(
  "create-session-mcp-union-and-strip",
  makeCommand({
    type: "createSession",
    payload: {
      workspaceId: "workspace",
      ignored: "stripped",
      mcpServers: [
        {
          name: " local ",
          command: " run ",
          args: [],
          env: [{ name: " KEY ", value: "unchanged" }],
        },
        {
          name: " remote ",
          type: "http",
          url: " https://example.invalid ",
          headers: [],
          oauth: {
            type: "authorization_code",
            clientId: " id ",
            clientName: " name ",
            redirectPath: " /callback ",
          },
        },
      ],
    },
  }),
);
const ackValues = [
  {
    commandId: "failed-command",
    status: "failed",
    reasonCode: "runtime.failed",
    message: "failed",
    revisionAtDecision: 12,
    memoryEnabled: true,
    ttftExcluded: "capacity",
  },
];
const acknowledgements = ackValues.map((value) => {
  const raw = JSON.stringify(value);
  return { raw, parsed: commandAckSchema.parse(JSON.parse(raw)) };
});
const oracle = { commands: cases, acknowledgements };

async function output(relativePath, value) {
  const path = new URL(relativePath, root);
  const rendered = `${JSON.stringify(value, null, 2)}\n`;
  const formatted = await format(path.pathname, rendered);
  if (formatted.errors.length) throw new Error(`Cannot format ${relativePath}`);
  if (process.argv.includes("--check")) {
    if ((await readFile(path, "utf8")) !== formatted.code)
      throw new Error(`${relativePath} differs from the live TS oracle; regenerate it`);
  } else {
    await mkdir(new URL(relativePath.substring(0, relativePath.lastIndexOf("/")), root), {
      recursive: true,
    });
    await writeFile(path, formatted.code);
  }
}
await output("schema/v4-command.json", data);
await output("tests/fixtures/ts-command-oracle.json", oracle);
await output("tests/fixtures/ts-command-trim-oracle.json", trimOracle);
