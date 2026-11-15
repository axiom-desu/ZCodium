import { z } from "zod";

// 命令与会话身份不能静默 trim，否则两个不同请求会被合并到同一个幂等键。
export const identifierSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => value.trim() === value && !value.includes("\0"),
    "Identifier must be canonical",
  );
export const workspacePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value) && !value.includes("\0"),
    "Expected an absolute workspace path",
  );
export const cliScopeSchema = z.strictObject({
  kind: z.literal("cli"),
  workspacePath: workspacePathSchema,
  workspaceIdentity: identifierSchema.optional(),
});
export const appProjectRefSchema = z.strictObject({
  kind: z.literal("app"),
  projectId: identifierSchema,
  sourceServerId: identifierSchema.optional(),
});
export const appWorkspaceRefSchema = z.strictObject({
  kind: z.literal("app"),
  workspacePath: workspacePathSchema,
  workspaceIdentity: identifierSchema.optional(),
  sourceServerId: identifierSchema.optional(),
});
export const appScopeSchema = z.discriminatedUnion("scope", [
  z.strictObject({
    kind: z.literal("app"),
    scope: z.literal("host"),
    sourceServerId: identifierSchema.optional(),
  }),
  appProjectRefSchema.extend({ scope: z.literal("project") }),
  appWorkspaceRefSchema.extend({ scope: z.literal("workspace") }),
]);
export const cliSessionRefSchema = cliScopeSchema.extend({ sessionId: identifierSchema });
export const appSessionRefSchema = appWorkspaceRefSchema.extend({
  sessionId: identifierSchema,
  project: appProjectRefSchema.optional(),
});
export const sessionRefSchema = z.discriminatedUnion("kind", [
  cliSessionRefSchema,
  appSessionRefSchema,
]);
export type CliScope = z.infer<typeof cliScopeSchema>;
export type AppProjectRef = z.infer<typeof appProjectRefSchema>;
export type AppWorkspaceRef = z.infer<typeof appWorkspaceRefSchema>;
export type AppScope = z.infer<typeof appScopeSchema>;
export type CliSessionRef = z.infer<typeof cliSessionRefSchema>;
export type AppSessionRef = z.infer<typeof appSessionRefSchema>;
export type SessionRef = CliSessionRef | AppSessionRef;
export type Scope = CliScope | AppScope;

// 模型可只传会话 ID；可信一侧解析为完整引用后，才进入原有授权与 owner 校验。
// 会话 ID 有两种历史格式，都必须接受：当前的 `sess_<UUID v4>`，以及 3.16 Host 持久化的
// `session_<32hex>` / `session_<UUID>`。读取必须按原身份精确查找，不能改写前缀后查另一个会话
// （docs/session-context-tool.md「Session identity compatibility」）。
// 校验格式的目的不只是挡住错值：模型曾传入 "dummy" 这类占位值，无格式约束时一路走到授权才被拒，
// 错误信息只说越权，看不出是 ID 本身不对。
const SESSION_ID_PATTERN = /^(?:sess|session)_[A-Za-z0-9._-]+$/;
export const sessionIdSchema = identifierSchema.regex(
  SESSION_ID_PATTERN,
  "Session id must look like sess_… or the legacy session_… form",
);
