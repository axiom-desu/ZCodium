/**
 * Agent 协议握手与响应校验的可读化。
 *
 * 问题背景：`session/messages`、`session/create` 等结果按严格 schema 校验，失败时原本直接把
 * `ZodError.message`（一整段 issues 文本）当错误消息抛出，最终渲染成聊天消息。用户读不懂，也无法
 * 自纠，而真正的根因（对端协议版本/键名与桌面端不一致）被埋在文本里。
 *
 * 这里只做两件事：从对端响应里读出协议身份、把校验失败收敛成稳定可读的文本。校验点不在这里，
 * 由 `zcodeProtocolClient.resolveResponse` 统一触发，避免每个业务方法各自拼协议错误。
 */

export const ZCODE_PROTOCOL_MISMATCH_REASON_CODE = "agent-protocol-mismatch" as const;
export const ZCODE_PROTOCOL_RESPONSE_INVALID_REASON_CODE = "agent-response-invalid" as const;

export interface ZcodeProtocolIdentity {
  name: string;
  version: number;
}

/** 错误消息会进入 UI，必须有界；超出部分截断而不是靠调用方各自裁剪。 */
const PROTOCOL_MESSAGE_MAX_CHARS = 300;
const DEFAULT_ISSUE_LIMIT = 3;

function truncateMessage(text: string): string {
  return text.length <= PROTOCOL_MESSAGE_MAX_CHARS
    ? text
    : `${text.slice(0, PROTOCOL_MESSAGE_MAX_CHARS - 1)}…`;
}

/**
 * 从任意响应体里读取 `protocol: { name, version }`。
 * 读不到或形状不合就返回 null——宁可在文本里写「未声明」，也不推断版本。
 */
export function readProtocolIdentity(value: unknown): ZcodeProtocolIdentity | null {
  if (typeof value !== "object" || value === null) return null;
  const protocol = (value as { protocol?: unknown }).protocol;
  if (typeof protocol !== "object" || protocol === null) return null;
  const { name, version } = protocol as { name?: unknown; version?: unknown };
  if (typeof name !== "string" || name.trim() === "") return null;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) return null;
  return { name: name.trim(), version };
}

export function isProtocolIdentityCompatible(
  expected: ZcodeProtocolIdentity,
  actual: ZcodeProtocolIdentity | null,
): boolean {
  return actual !== null && actual.name === expected.name && actual.version === expected.version;
}

/**
 * 鸭子类型读取 `issues`（不引 zod）：服务层可能同时处理 zod 3/4 或类 zod 错误。
 * 只保最多 `limit` 条字段路径；Zod message 也可能内含对端原始输入，不进入 UI 正文。
 */
export function summarizeProtocolIssues(error: unknown, limit = DEFAULT_ISSUE_LIMIT): string[] {
  const issues = (error as { issues?: unknown } | null | undefined)?.issues;
  if (!Array.isArray(issues)) return [];
  const summarized: string[] = [];
  for (const issue of issues) {
    if (summarized.length >= limit) break;
    if (typeof issue !== "object" || issue === null) continue;
    const path = (issue as { path?: unknown }).path;
    const pathText = Array.isArray(path) && path.length > 0 ? path.map(String).join(".") : "(root)";
    summarized.push(`${pathText}: invalid`);
  }
  return summarized;
}

function describeIdentity(identity: ZcodeProtocolIdentity): string {
  return `${identity.name} v${identity.version}`;
}

export function formatZcodeProtocolMismatchMessage(params: {
  method: string;
  expected: ZcodeProtocolIdentity;
  actual: ZcodeProtocolIdentity | null;
}): string {
  const actualText = params.actual ? describeIdentity(params.actual) : "未声明协议版本";
  return truncateMessage(
    `Agent 协议不兼容（${params.method}）：本机 ${describeIdentity(
      params.expected,
    )}，对端 ${actualText}。请将桌面端与 Agent 升级到同一版本。`,
  );
}

export function formatZcodeResponseInvalidMessage(params: {
  method: string;
  expected: ZcodeProtocolIdentity;
  actual: ZcodeProtocolIdentity | null;
  issues: string[];
}): string {
  const issueText = params.issues.length > 0 ? `字段问题：${params.issues.join("; ")}。` : "";
  return truncateMessage(
    `Agent 响应格式不符合协议（${params.method}）：本机 ${describeIdentity(
      params.expected,
    )}，对端 ${params.actual ? describeIdentity(params.actual) : "未声明协议版本"}。${issueText}请检查 Agent 与桌面端的协议实现。`,
  );
}
