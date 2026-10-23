import { applyPatch, type StructuredPatch } from "diff";
import { RewindScope, SessionEventType } from "../deps.js";
import { selectCheckpointForRewind, selectCheckpointsForMessages } from "../helpers/index.js";
import type {
  CheckpointCreatedPayload,
  MessageId,
  TurnId,
  WorkspaceCheckpointArtifact,
} from "../deps.js";

export interface CheckpointTarget {
  targetCheckpointId?: string;
  targetMessageId?: MessageId;
  targetMessageIds?: MessageId[];
  targetTurnId?: TurnId;
}

export function resolveTargetCheckpoints(
  events: Parameters<typeof selectCheckpointForRewind>[0],
  target: CheckpointTarget,
): CheckpointCreatedPayload[] {
  const targetMessageIds =
    target.targetMessageIds && target.targetMessageIds.length > 0
      ? target.targetMessageIds
      : target.targetMessageId
        ? [target.targetMessageId]
        : [];
  if (targetMessageIds.length > 0) {
    const checkpoints = selectCheckpointsForMessages(events, targetMessageIds);
    if (checkpoints.length > 0 || !target.targetTurnId) {
      return checkpoints;
    }
  }

  if (target.targetTurnId && !String(target.targetTurnId).includes("~")) {
    // 旧 TurnStarted 没有 user messageId，无法通过 rowId->messageId
    // 找到 workspace checkpoint；普通 turn 可用事件 turnId 精确兜底。split
    // product turn 带 "~q" 后缀，不能按 runtime turnId 兜底，避免串到其他 queued turn。
    return events
      .filter((event) => event.type === SessionEventType.CheckpointCreated)
      .filter((event) => String(event.turnId ?? "") === String(target.targetTurnId))
      .map((event) => event.payload)
      .filter((payload): payload is CheckpointCreatedPayload => {
        const checkpoint = payload as Partial<CheckpointCreatedPayload>;
        return checkpoint.scope === RewindScope.Workspace || checkpoint.scope === RewindScope.Both;
      });
  }

  const checkpoint = selectCheckpointForRewind(events, target.targetCheckpointId);
  return checkpoint ? [checkpoint] : [];
}

export function resolveCheckpointAfterContent(
  file: WorkspaceCheckpointArtifact["files"][number],
): string | null | undefined {
  const afterContent = (file as { afterContent?: unknown }).afterContent;
  if (typeof afterContent === "string") {
    return afterContent;
  }

  if (!file.existedBefore && file.beforeContent === null && file.structuredPatch.length === 0) {
    return undefined;
  }

  const beforeContent = file.beforeContent ?? "";
  const patch: StructuredPatch = {
    oldFileName: file.path,
    newFileName: file.path,
    oldHeader: undefined,
    newHeader: undefined,
    hunks: file.structuredPatch,
  };
  const patched = applyPatch(beforeContent, patch, {
    autoConvertLineEndings: false,
    fuzzFactor: 0,
  });
  return typeof patched === "string" ? patched : undefined;
}

export function isIgnoredShellTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "bash" ||
    normalized === "shell" ||
    normalized.includes("terminal") ||
    normalized.endsWith("shell")
  );
}
