import { createHash } from "node:crypto";

/**
 * App 请求的命令幂等身份：同一 caller + requestId 重放必须命中同一条命令。
 * create 与 fork 共用同一身份规则；App 层不另建回执表。
 */
export function appControlCommandId(callerId: string, requestId: string): string {
  return `app-control-${createHash("sha256")
    .update(JSON.stringify([callerId, requestId]))
    .digest("hex")}`;
}
