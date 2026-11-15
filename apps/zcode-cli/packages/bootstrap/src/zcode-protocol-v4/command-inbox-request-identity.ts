// 一次输入的请求身份（幂等键的“内容”一半）。
//
// commandId 是幂等键的名字，payload 是它的内容。过去同 commandId 携带不同内容会被当成
// 合法重试直接回放旧 ACK：用户改了正文或选区批注后重发，得到“成功”但执行的是旧输入。
// 这里把内容收敛成一个摘要，供 CommandInbox 在返回 duplicate 之前先判定冲突。
//
// 只覆盖“内容完全由调用方决定”的输入命令：sendText / sendGoalCommand / editUserQuery /
// editQueueItem。createSession 的 payload 会被 Host 按当次预占补入 sessionId 与附加目录，
// 那不是请求身份，本文件不参与它的判定。
import { createHash } from "node:crypto";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";

const IDENTITY_SCOPED_COMMANDS: ReadonlySet<CommandEnvelope["type"]> = new Set([
  "sendText",
  "sendGoalCommand",
  "editUserQuery",
  "editQueueItem",
]);

/**
 * 由 Host 在派发时补入、随环境漂移的字段：它们不表达“用户请求了什么”。
 * - `browserAmbientContext`：本次运行时抓到的浏览器环境，重试时可能不同；
 * - `toolDisallowlist`：automation turn 由 Host 合并 denylist，同一次请求可被补写。
 */
const HOST_DERIVED_PAYLOAD_FIELDS: ReadonlySet<string> = new Set([
  "browserAmbientContext",
  "toolDisallowlist",
]);

export function requestIdentityOf(envelope: CommandEnvelope): string | undefined {
  if (!IDENTITY_SCOPED_COMMANDS.has(envelope.type)) return undefined;
  const payload = envelope.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const identityPayload = Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).filter(
      ([key]) => !HOST_DERIVED_PAYLOAD_FIELDS.has(key),
    ),
  );
  const content = JSON.stringify(
    [envelope.clientId, envelope.type, identityPayload],
    // 键序无关：同一份内容经不同构造顺序（UI 组装 vs 宿主重放）必须得到同一摘要。
    (_key, value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
          )
        : value,
  );
  return createHash("sha256").update(content).digest("hex");
}
