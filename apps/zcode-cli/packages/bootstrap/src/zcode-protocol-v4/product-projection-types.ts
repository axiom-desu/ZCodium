import type { ModelSelectedPayload, TurnInputIntentMetadata } from "@zcode/contracts";
import type {
  ConversationRow,
  RunningSubagentSummary,
  SessionUsageState,
} from "@zcode/shared/zcode-protocol-v4";

import type { CanonicalUserIntentFact } from "./event-normalizer.js";

/**
 * config 种子：投影初始化/冷恢复后从 runtime 真值注入的初值。
 * 与事件写入路径（ModelSelected / SessionModeChanged）的关系：种子只填「事件尚未
 * 触碰」的字段——日志重放值永远优先（"最终值以日志为准"）。
 */
export interface SessionConfigSeed {
  permissionGrant?: { interactionId: string };
  planEnabled?: boolean;
  modelSelection?: ModelSelectedPayload["modelSelection"];
  provider?: string;
  model?: string;
  thought?: string;
  thoughtLevels?: readonly string[];
  mode?: string;
}

export interface SessionUsageSeed {
  contextWindow: Omit<NonNullable<SessionUsageState["contextWindow"]>, "maxTokens"> & {
    maxTokens: number | null;
  };
  cumulative?: Partial<SessionUsageState["cumulative"]>;
}

export interface ContextWindowProjectionState {
  maxTokens: number | null;
  touchedByEvent: boolean;
  usedTokens: number;
}

export interface SessionSubagentsSeed {
  revision: number;
  childSessionIds: string[];
  running: RunningSubagentSummary[];
}

export interface StableForkCandidate {
  productTurnId: string;
  transcriptTurnId: string;
  startMessageId: string | null;
  boundaryMessageId: string;
}

export type StableForkCandidateResolution =
  | { ok: true; candidate: StableForkCandidate }
  | {
      ok: false;
      reasonCode:
        | "guard.forkAssistantOnly"
        | "guard.forkTargetNotStable"
        | "guard.forkTargetAmbiguous"
        | "guard.compactOperationLock";
    };

export interface ConversationEditTarget {
  entityId: string;
  productTurnId: string;
  transcriptMessageId: string;
  coveredByStableCompact: boolean;
  intent: {
    kind: "sendText" | "sendGoalCommand";
    text: string;
    sourceCommandId?: string;
    clientId?: string;
    attachments?: CanonicalUserIntentFact["attachments"];
    queueItemId?: string;
    admissionSeq?: number;
    admittedAt?: number;
    requestedDelivery?: "auto" | "startNow" | "queue" | "guide";
    admittedDelivery?: "startNow" | "queue" | "guide";
    fallbackReasonCode?: string;
    modelSelection?: TurnInputIntentMetadata["modelSelection"];
    mode?: TurnInputIntentMetadata["mode"];
    planEnabled?: boolean;
    provenance?: CanonicalUserIntentFact["provenance"];
  };
}

export type ConversationRowTargetAction =
  | "forkAssistant"
  | "editUserQuery"
  | "retryTurn"
  | "applyFileRewind"
  | "fileChanges"
  | "fileRewindPreview"
  | "setAssistantFeedback";

export type ConversationRowTargetResolution =
  | {
      ok: true;
      action: ConversationRowTargetAction;
      row: ConversationRow;
      editTarget?: ConversationEditTarget;
      messageId?: string;
      messageIds?: string[];
    }
  | {
      ok: false;
      status: "stale" | "rejected";
      reasonCode: "proto.staleTarget" | "guard.actionUnavailable";
    };
