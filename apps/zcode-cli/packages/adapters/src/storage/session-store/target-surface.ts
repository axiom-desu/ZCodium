import type { GoalStatus, SessionGoal, SessionId } from "@zcode/contracts";
import {
  accountSessionTargetUsage,
  clearSessionTarget,
  cloneSessionTargetForFork,
  createSessionTarget,
  finishSessionTargetRun,
  heartbeatSessionTargetRun,
  readSessionTarget,
  recoverInterruptedSessionTargetRun,
  setSessionTarget,
  startSessionTargetRun,
  updateSessionTargetSummaryTitle,
  updateSessionTargetStatus,
} from "../session-target.js";
import { RepositorySurface } from "./repository-surface.js";

export class TargetSurface extends RepositorySurface {
  async readTarget(input: { sessionID: SessionId }): Promise<SessionGoal | null> {
    return readSessionTarget(this.db, input);
  }

  async setTarget(input: {
    objective: string;
    sessionID: SessionId;
    status?: GoalStatus;
    tokenBudget?: number | null;
  }): Promise<SessionGoal> {
    return setSessionTarget(this.db, {
      objective: input.objective,
      sessionID: input.sessionID,
      status: input.status ?? "active",
      tokenBudget: input.tokenBudget,
    });
  }

  async cloneTargetForFork(input: {
    source: SessionGoal;
    sessionID: SessionId;
    status?: GoalStatus;
  }): Promise<SessionGoal> {
    this.throwBeforeWrite();
    return cloneSessionTargetForFork(this.db, {
      source: input.source,
      sessionID: input.sessionID,
      status: input.status ?? input.source.status,
    });
  }

  async createTarget(input: {
    objective: string;
    sessionID: SessionId;
    tokenBudget?: number | null;
  }): Promise<SessionGoal | null> {
    return createSessionTarget(this.db, input);
  }

  async updateTargetStatus(input: {
    sessionID: SessionId;
    status: GoalStatus;
  }): Promise<SessionGoal | null> {
    return updateSessionTargetStatus(this.db, input);
  }

  async startTargetRun(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    startedAtMs: number;
  }): Promise<SessionGoal | null> {
    return startSessionTargetRun(this.db, input);
  }

  async heartbeatTargetRun(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    seenAtMs: number;
  }): Promise<SessionGoal | null> {
    return heartbeatSessionTargetRun(this.db, input);
  }

  async finishTargetRun(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    endedAtMs: number;
    status?: GoalStatus;
    tokensUsedDelta?: number;
  }): Promise<SessionGoal | null> {
    return finishSessionTargetRun(this.db, input);
  }

  async recoverInterruptedTargetRun(input: { sessionID: SessionId }): Promise<SessionGoal | null> {
    return recoverInterruptedSessionTargetRun(this.db, input);
  }

  async accountTargetUsage(input: {
    sessionID: SessionId;
    targetID: string;
    tokensUsedDelta?: number;
    timeUsedSecondsDelta?: number;
  }): Promise<SessionGoal | null> {
    return accountSessionTargetUsage(this.db, input);
  }

  async updateTargetSummaryTitle(input: {
    sessionID: SessionId;
    targetID: string;
    summaryTitle: string;
  }): Promise<SessionGoal | null> {
    return updateSessionTargetSummaryTitle(this.db, input);
  }

  async clearTarget(input: { sessionID: SessionId }): Promise<boolean> {
    return clearSessionTarget(this.db, input);
  }
}
