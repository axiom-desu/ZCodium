import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  ROW_TARGETING_COMMANDS,
} from "@zcode/shared/zcode-protocol-v4";

/** guard 裁决结果：拒绝（撤 optimistic）或 noop（晚到者静默收口）。 */
export type GuardDecision =
  | { verdict: "allow" }
  | { verdict: "stale"; reasonCode: string; message?: string }
  | { verdict: "reject"; reasonCode: string; message?: string }
  | { verdict: "noop"; reasonCode: string; result?: CommandAck["result"] };

/** CommandInbox 的裁决只读视图：不持有队列，也不产生第二份 revision 事实。 */
export interface CommandAdmissionHost {
  /** 会话当前 revision；未知会话返回 null（createSession 用 null sessionId）。 */
  getRevision(sessionId: string): number | null;
  /** 会话当前投影代际；CAS 必须先校验 epoch，再校验 revision。 */
  getLogEpoch(sessionId: string): string | null;
  /** row-targeting command 的 entity/action 同源 resolver 裁决。 */
  validateRowTarget?(envelope: CommandEnvelope): GuardDecision;
  /** 业务 guard（product-protocol guard id）。缺省一律放行。 */
  guard?(envelope: CommandEnvelope): GuardDecision;
}

type CommandAdmissionDecision =
  | { kind: "execute"; ack: CommandAck }
  | { kind: "ack"; ack: CommandAck; remember: boolean };

export function decideCommandAdmission(
  host: CommandAdmissionHost,
  envelope: CommandEnvelope,
): CommandAdmissionDecision {
  const revision = envelope.sessionId === null ? 0 : host.getRevision(envelope.sessionId);
  if (revision === null || (envelope.type !== "createSession" && envelope.sessionId === null)) {
    return {
      kind: "ack",
      remember: false,
      ack: {
        commandId: envelope.commandId,
        status: "rejected",
        reasonCode: "proto.sessionNotFound",
        revisionAtDecision: 0,
      },
    };
  }

  if (COMMANDS_REQUIRING_BASE_REVISION.has(envelope.type)) {
    if (envelope.baseRevision === undefined) {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "rejected",
          reasonCode: "proto.missingBaseRevision",
          revisionAtDecision: revision,
        },
      };
    }
    const logEpoch = envelope.sessionId === null ? null : host.getLogEpoch(envelope.sessionId);
    if (ROW_TARGETING_COMMANDS.has(envelope.type) && envelope.baseLogEpoch !== logEpoch) {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "stale",
          reasonCode: "proto.staleLogEpoch",
          revisionAtDecision: revision,
        },
      };
    }
    if (envelope.baseRevision !== revision) {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "stale",
          reasonCode: "proto.staleRevision",
          revisionAtDecision: revision,
        },
      };
    }
  }

  const targetDecision = host.validateRowTarget?.(envelope);
  if (targetDecision?.verdict === "stale") {
    return {
      kind: "ack",
      remember: false,
      ack: {
        commandId: envelope.commandId,
        status: "stale",
        reasonCode: targetDecision.reasonCode,
        message: targetDecision.message,
        revisionAtDecision: revision,
      },
    };
  }
  if (targetDecision?.verdict === "reject") {
    return {
      kind: "ack",
      remember: false,
      ack: {
        commandId: envelope.commandId,
        status: "rejected",
        reasonCode: targetDecision.reasonCode,
        message: targetDecision.message,
        revisionAtDecision: revision,
      },
    };
  }

  const decision = host.guard?.(envelope) ?? { verdict: "allow" as const };
  if (decision.verdict === "stale") {
    return {
      kind: "ack",
      remember: false,
      ack: {
        commandId: envelope.commandId,
        status: "stale",
        reasonCode: decision.reasonCode,
        message: decision.message,
        revisionAtDecision: revision,
      },
    };
  }
  if (decision.verdict === "reject") {
    return {
      kind: "ack",
      remember: false,
      ack: {
        commandId: envelope.commandId,
        status: "rejected",
        reasonCode: decision.reasonCode,
        message: decision.message,
        revisionAtDecision: revision,
      },
    };
  }
  if (decision.verdict === "noop") {
    return {
      kind: "ack",
      remember: true,
      ack: {
        commandId: envelope.commandId,
        status: "noop",
        reasonCode: decision.reasonCode,
        revisionAtDecision: revision,
        result: decision.result,
      },
    };
  }
  return {
    kind: "execute",
    ack: {
      commandId: envelope.commandId,
      status: "accepted",
      revisionAtDecision: revision,
    },
  };
}
