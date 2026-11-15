import { z } from "zod";
import {
  cliCreateSessionInputSchema,
  cliForkSessionInputSchema,
  cliInterruptSessionInputSchema,
  cliListSessionsInputSchema,
  cliReadSessionInputSchema,
  cliRenameSessionInputSchema,
  cliSendToSessionInputSchema,
} from "./contract/cli.js";
import { cliWaitSessionsInputSchema } from "./contract/observation.js";
import { createSessionResultSchema, forkSessionResultSchema } from "./contract/results.js";
import {
  listSessionsResultSchema,
  readSessionResultSchema,
  sendToSessionResultSchema,
} from "./contract/results.js";
import { mutationResultSchema } from "./contract/common.js";
import { waitSessionsResultSchema } from "./contract/observation.js";

type Shape = z.ZodType;

/**
 * 规格 0.11 / 0.14：模型只看 `tool` 变体——没有完整引用，也没有 `requestId`。
 * 端口与用例层仍用原 schema，list/read 的返回值继续携带完整引用供展示与跨层路由。
 */
function modelFacing(schema: Shape): Shape {
  const variant = (schema as { tool?: Shape }).tool;
  return variant ?? schema;
}
/** 该工具是否需要请求身份：工具面有 `retryOf` 的，端口那边就要 `requestId`。 */
function needsRequestId(schema: Shape): boolean {
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  return shape !== undefined && "retryOf" in shape;
}

export interface SessionControlToolContract {
  readonly name: string;
  readonly method:
    | "listSessions"
    | "readSession"
    | "createSession"
    | "forkSession"
    | "sendToSession"
    | "waitSessions"
    | "interruptSession"
    | "renameSession"
    | "listProjects"
    | "openSession"
    | "setSessionArchived"
    | "setSessionPinned";
  readonly hint: string;
  readonly description: string;
  readonly readOnly: boolean;
  /** provider 可见的 JSON Schema（io: input，默认值字段不会被标成必填）。 */
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  /** 工具面输入 schema；handler 用它解析模型输入。 */
  readonly input: Shape;
  /** 输出 schema；handler 返回前复验。 */
  readonly output: Shape;
  readonly hasRetryIdentity: boolean;
}

const sharedInstructions = [
  "Target an existing session by its sessionId. When you do not know the id, find it with ListSessions by title substring; never infer identity from a title or a path.",
  "Create or send work only when authorized by the user or an existing delegation. Keep the target session's permissions; this tool never approves its later permission requests.",
  "Accepted or queued means admitted, not completed. Wait for the returned operation, and surface needs_attention to the user.",
] as const;
/**
 * 重试指令只给真正收 `retryOf` 的写工具（规格 0.14）。
 * 过去这一条和其余三条一起发给全部工具，于是 ListSessions 这类只读工具也被告知一个它不接受的参数
 * ——模型可见文案必须与该工具的 schema 一致，否则就是在教它传会被拒的字段。
 */
const retryInstruction =
  "An inconclusive result needs reconciliation, not a fresh call: take the requestId from that result and pass it as `retryOf`. Otherwise leave `retryOf` out — there is no requestId input to set." as const;

export function sessionControlModelInstructions(contract: SessionControlToolContract) {
  return contract.hasRetryIdentity
    ? [...sharedInstructions, retryInstruction]
    : [...sharedInstructions];
}

interface Definition {
  readonly name: string;
  readonly method: SessionControlToolContract["method"];
  readonly hint: string;
  readonly description: string;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly readOnly?: boolean;
}
const definitions: readonly Definition[] = [
  {
    name: "ListSessions",
    method: "listSessions",
    hint: "find sessions in the bound workspace by title",
    description:
      "List authorized sessions and their actual available actions without resuming or navigating.",
    input: cliListSessionsInputSchema,
    output: listSessionsResultSchema,
    readOnly: true,
  },
  {
    name: "ReadSession",
    method: "readSession",
    hint: "read session status or message history",
    description:
      "Read a session summary or bounded history without execution, navigation or marking it read.",
    input: cliReadSessionInputSchema,
    output: readSessionResultSchema,
    readOnly: true,
  },
  {
    name: "CreateSession",
    method: "createSession",
    hint: "create an independent session with a first prompt",
    description:
      "Create a root session and submit its first prompt. Creation and input admission are reported separately. Does not steal focus.",
    input: cliCreateSessionInputSchema,
    output: createSessionResultSchema,
  },
  {
    name: "ForkSession",
    method: "forkSession",
    hint: "fork a session at a stable message",
    description:
      "Fork at an explicit stable message boundary. Does not copy running tools, permission approvals, pending inputs, or change workspace files. Does not send a prompt.",
    input: cliForkSessionInputSchema,
    output: forkSessionResultSchema,
  },
  {
    name: "SendToSession",
    method: "sendToSession",
    hint: "send a prompt to an existing session",
    description:
      "Submit input to the target session owner. Busy targets queue it. Preserve the target model, mode and permissions.",
    input: cliSendToSessionInputSchema,
    output: sendToSessionResultSchema,
  },
  {
    name: "WaitSessions",
    method: "waitSessions",
    hint: "wait for specific session operations",
    description:
      "Wait for the exact create/send operations, using any or all. timeoutMs=0 queries now. Cancelling this wait does not stop target execution. Never wait for your own future completion.",
    input: cliWaitSessionsInputSchema,
    output: waitSessionsResultSchema,
    readOnly: true,
  },
  {
    name: "InterruptSession",
    method: "interruptSession",
    hint: "interrupt an observed session execution",
    description:
      "Interrupt only expectedExecutionId. A changed execution is rejected; session history is retained.",
    input: cliInterruptSessionInputSchema,
    output: mutationResultSchema,
  },
  {
    name: "RenameSession",
    method: "renameSession",
    hint: "rename a session title",
    description: "Set the target session title through its metadata owner.",
    input: cliRenameSessionInputSchema,
    output: mutationResultSchema,
  },
];

/** 8 个独立 CLI 会话工具的契约面：名字、文案、JSON Schema 与运行时 schema 同源。 */
export const cliSessionControlToolContracts: readonly SessionControlToolContract[] =
  definitions.map((definition) => {
    const input = modelFacing(definition.input);
    return {
      name: definition.name,
      method: definition.method,
      hint: definition.hint,
      description: definition.description,
      readOnly: definition.readOnly === true,
      // io: "input" —— 默认按 output 投影会把 .default() 的字段算进 required，于是 timeoutMs
      // 带着默认值却被标成必填，与「可以省略」的工具说明直接矛盾（规格 0.14）。
      inputSchema: z.toJSONSchema(input, { io: "input" }) as Record<string, unknown>,
      outputSchema: z.toJSONSchema(definition.output) as Record<string, unknown>,
      input,
      output: definition.output,
      hasRetryIdentity: needsRequestId(input),
    };
  });
