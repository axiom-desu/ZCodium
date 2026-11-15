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
import { appWaitSessionsInputSchema, waitSessionsResultSchema } from "./contract/observation.js";
import {
  mutationResultSchema,
  openSessionResultSchema,
  sessionControlErrorCodeSchema,
} from "./contract/common.js";
import {
  createSessionResultSchema,
  forkSessionResultSchema,
  readSessionResultSchema,
  sendToSessionResultSchema,
} from "./contract/results.js";

/**
 * CLI ↔ Host 的 App 控制线协议：封闭的十二个意图，不接受任意 service/method 名称。
 * 身份字段（callerSessionId/callId）只由 CLI 工具执行上下文注入，模型看不到也传不进。
 */
const bindingFields = {
  callerSessionId: z.string().trim().min(1).max(4096),
  callId: z.string().trim().min(1).max(4096),
};
const failure = z.strictObject({
  ok: z.literal(false),
  error: z.strictObject({ code: sessionControlErrorCodeSchema, message: z.string() }),
});
function method<K extends string, I extends z.ZodType, O extends z.ZodType>(
  name: K,
  input: I,
  result: O,
) {
  return {
    method: `appControl/${name}` as const,
    params: z.strictObject({
      ...bindingFields,
      turnId: z.string().trim().min(1).max(4096).optional(),
      input,
    }),
    result: z.discriminatedUnion("ok", [z.strictObject({ ok: z.literal(true), result }), failure]),
  };
}

export const appControlProtocol = {
  listProjects: method("listProjects", appListProjectsInputSchema, listProjectsResultSchema),
  listSessions: method("listSessions", appListSessionsInputSchema, appListSessionsResultSchema),
  readSession: method("readSession", appReadSessionInputSchema, readSessionResultSchema),
  createSession: method("createSession", appCreateSessionInputSchema, createSessionResultSchema),
  forkSession: method("forkSession", appForkSessionInputSchema, forkSessionResultSchema),
  sendToSession: method("sendToSession", appSendToSessionInputSchema, sendToSessionResultSchema),
  waitSessions: method("waitSessions", appWaitSessionsInputSchema, waitSessionsResultSchema),
  interruptSession: method(
    "interruptSession",
    appInterruptSessionInputSchema,
    mutationResultSchema,
  ),
  renameSession: method("renameSession", appRenameSessionInputSchema, mutationResultSchema),
  openSession: method("openSession", appOpenSessionInputSchema, openSessionResultSchema),
  setSessionArchived: method(
    "setSessionArchived",
    appSetSessionArchivedInputSchema,
    mutationResultSchema,
  ),
  setSessionPinned: method(
    "setSessionPinned",
    appSetSessionPinnedInputSchema,
    mutationResultSchema,
  ),
} as const;
export type AppControlAction = keyof typeof appControlProtocol;
export const appControlCancelMethod = "appControl/cancel" as const;
export const appControlCancelParamsSchema = z.strictObject(bindingFields);
export const appControlCancelResultSchema = z.strictObject({ cancelled: z.boolean() });
export type AppControlRpcParams<A extends AppControlAction> = z.infer<
  (typeof appControlProtocol)[A]["params"]
>;
export type AppControlRpcResult<A extends AppControlAction> = z.infer<
  (typeof appControlProtocol)[A]["result"]
>;
