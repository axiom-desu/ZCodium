import { z } from "zod";
import {
  appCreateSessionInputSchema,
  appForkSessionInputSchema,
  appInterruptSessionInputSchema,
  appListProjectsInputSchema,
  appListSessionsInputSchema,
  appListSessionsResultSchema,
  appOpenSessionInputSchema,
  appReadSessionInputSchema,
  appRenameSessionInputSchema,
  appSendToSessionInputSchema,
  appSetSessionArchivedInputSchema,
  appSetSessionPinnedInputSchema,
  listProjectsResultSchema,
} from "./contract/app.js";
import { mutationResultSchema, openSessionResultSchema } from "./contract/common.js";
import { appWaitSessionsInputSchema, waitSessionsResultSchema } from "./contract/observation.js";
import {
  createSessionResultSchema,
  forkSessionResultSchema,
  readSessionResultSchema,
  sendToSessionResultSchema,
} from "./contract/results.js";
import type { SessionControlToolContract } from "./tool-contracts.js";

const APP_ONLY_METHODS = [
  "listProjects",
  "openSession",
  "setSessionArchived",
  "setSessionPinned",
] as const;

type Shape = z.ZodType;
const modelFacing = (schema: Shape): Shape => (schema as { tool?: Shape }).tool ?? schema;
const needsRequestId = (schema: Shape): boolean => {
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  return shape !== undefined && "retryOf" in shape;
};

interface AppDefinition {
  name: string;
  method: SessionControlToolContract["method"] | (typeof APP_ONLY_METHODS)[number];
  hint: string;
  description: string;
  input: Shape;
  output: Shape;
  readOnly?: boolean;
}

const definitions: readonly AppDefinition[] = [
  {
    name: "ListProjects",
    method: "listProjects",
    hint: "list accessible App projects and devices",
    description:
      "List projects in trusted discovery scopes without starting a session. searchScope.scopes reports successfully searched ranges; empty results mean no matches only there. Discovery does not grant read or control access.",
    input: appListProjectsInputSchema,
    output: listProjectsResultSchema,
    readOnly: true,
  },
  {
    name: "ListSessions",
    method: "listSessions",
    hint: "find App sessions across projects by title substring",
    description:
      'List App sessions across projects by case-insensitive title substring, not full-text message search. Search unarchived sessions first: omit archived or use archived:"exclude". searchScope.scopes reports searched ranges; empty scopes means no range was successfully searched. Does not resume or navigate.',
    input: appListSessionsInputSchema,
    output: appListSessionsResultSchema,
    readOnly: true,
  },
  {
    name: "ReadSession",
    method: "readSession",
    hint: "read session status or message history",
    description:
      "Read a session summary or bounded history without execution, navigation or marking it read.",
    input: appReadSessionInputSchema,
    output: readSessionResultSchema,
    readOnly: true,
  },
  {
    name: "CreateSession",
    method: "createSession",
    hint: "create an independent App session with a first prompt",
    description:
      "Create a root session in an existing project and submit its first prompt. Creation and input admission are reported separately. Does not steal focus.",
    input: appCreateSessionInputSchema,
    output: createSessionResultSchema,
  },
  {
    name: "ForkSession",
    method: "forkSession",
    hint: "fork an App session at a stable message",
    description:
      "Fork at an explicit stable message boundary. Reported unavailable when this Host or runtime has no stable fork owner; never silently creates a new session.",
    input: appForkSessionInputSchema,
    output: forkSessionResultSchema,
  },
  {
    name: "SendToSession",
    method: "sendToSession",
    hint: "send a prompt to an existing App session",
    description:
      "Submit input to the target session owner. Busy targets queue it. Preserve the target model, mode and permissions.",
    input: appSendToSessionInputSchema,
    output: sendToSessionResultSchema,
  },
  {
    name: "WaitSessions",
    method: "waitSessions",
    hint: "wait for specific App session operations",
    description:
      "Wait for the exact create/send operations, using any or all. timeoutMs=0 queries now. Cancelling this wait does not stop target execution. Never wait for your own future completion.",
    input: appWaitSessionsInputSchema,
    output: waitSessionsResultSchema,
    readOnly: true,
  },
  {
    name: "InterruptSession",
    method: "interruptSession",
    hint: "interrupt an observed App session execution",
    description:
      "Interrupt only expectedExecutionId. A changed execution is rejected; session history is retained.",
    input: appInterruptSessionInputSchema,
    output: mutationResultSchema,
  },
  {
    name: "RenameSession",
    method: "renameSession",
    hint: "rename an App session title",
    description: "Set the target session title through its metadata owner.",
    input: appRenameSessionInputSchema,
    output: mutationResultSchema,
  },
  {
    name: "OpenSession",
    method: "openSession",
    hint: "open a session in the bound App window",
    description:
      "Open the session in the UI bound to this caller. Unavailable UI is reported without fallback navigation.",
    input: appOpenSessionInputSchema,
    output: openSessionResultSchema,
  },
  {
    name: "SetSessionArchived",
    method: "setSessionArchived",
    hint: "archive or restore an App session",
    description:
      "Archive or restore a product session. Archiving does not interrupt its execution.",
    input: appSetSessionArchivedInputSchema,
    output: mutationResultSchema,
  },
  {
    name: "SetSessionPinned",
    method: "setSessionPinned",
    hint: "pin or unpin an App session",
    description: "Pin or unpin a product session without changing its execution.",
    input: appSetSessionPinnedInputSchema,
    output: mutationResultSchema,
  },
];

/** 12 个 App 会话工具的契约面：名字、文案、JSON Schema 与运行时 schema 同源。 */
export const appSessionControlToolContracts = definitions.map((definition) => {
  const input = modelFacing(definition.input);
  return {
    name: definition.name,
    method: definition.method,
    hint: definition.hint,
    description: definition.description,
    readOnly: definition.readOnly === true,
    inputSchema: z.toJSONSchema(input, { io: "input" }) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(definition.output) as Record<string, unknown>,
    input,
    output: definition.output,
    hasRetryIdentity: needsRequestId(input),
  } as SessionControlToolContract;
});
