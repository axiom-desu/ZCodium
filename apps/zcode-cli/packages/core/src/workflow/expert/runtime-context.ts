import { randomUUID } from "node:crypto";
import {
  WorkflowDefinitionSchema,
  deriveWorkflowSessionLinks,
  type ExpertWorkflowRunSnapshot,
  type WorkflowActivitySnapshot,
  type WorkflowArtifact,
  type WorkflowDefinition,
  type WorkflowEvent,
  type WorkflowNodeStatus,
  type WorkflowPhaseDefinition,
  type WorkflowPhaseSnapshot,
} from "@zcode/contracts";
import { createExpertWorkflowDefinition, workflowDefinitionPhaseMap } from "../definition.js";
import type { WorkflowGraphNodeChange, WorkflowSnapshotLifecycleResult } from "../lifecycle.js";
import { phaseNodeId, safeRunIdSegment } from "./ids.js";
import { createPhaseGraph, updateGraphNodeStatus } from "./prompts.js";
import type { ExpertWorkflowLookupOptions, ExpertWorkflowRuntimeDeps } from "./types.js";

export class ExpertWorkflowRuntimeContext {
  readonly activeRunAbortControllers = new Map<string, AbortController>();
  readonly agentRunner: ExpertWorkflowRuntimeDeps["agentRunner"];
  readonly createActivityId: () => string;
  readonly createRunId: () => string;
  readonly definition: WorkflowDefinition;
  readonly now: () => Date;
  readonly onWorkflowEvent?: (event: WorkflowEvent) => void | Promise<void>;
  readonly phaseDefinitions: Map<string, WorkflowPhaseDefinition>;
  readonly store: ExpertWorkflowRuntimeDeps["store"];

  constructor(deps: ExpertWorkflowRuntimeDeps) {
    this.definition = WorkflowDefinitionSchema.parse(
      deps.definition ?? createExpertWorkflowDefinition(),
    );
    this.phaseDefinitions = workflowDefinitionPhaseMap(this.definition);
    this.agentRunner = deps.agentRunner;
    this.createActivityId = deps.createActivityId ?? (() => `act_${randomUUID()}`);
    this.createRunId =
      deps.createRunId ?? (() => `wf_${safeRunIdSegment(this.definition.kind)}_${randomUUID()}`);
    this.now = deps.now ?? (() => new Date());
    this.onWorkflowEvent = deps.onWorkflowEvent;
    this.store = deps.store;
  }

  createInitialSnapshot(options: {
    cwd: string;
    sessionId?: string;
    task: string;
    traceContext?: { traceId: string };
  }): ExpertWorkflowRunSnapshot {
    const runId = this.createRunId();
    const timestamp = this.timestamp();
    const phaseOrder = this.definition.phaseOrder;
    return {
      activities: [],
      artifacts: [],
      createdAt: timestamp,
      cwd: options.cwd,
      definitionId: this.definition.definitionId,
      definitionVersion: this.definition.definitionVersion,
      graph: createPhaseGraph(this.definition),
      kind: this.definition.kind,
      phaseOrder,
      phases: phaseOrder.map((phase) => ({
        phase,
        status: "pending",
      })),
      recoveryActions: [],
      runId,
      schemaVersion: 1,
      sessionId: options.sessionId,
      sessionLinks: [],
      status: "pending",
      strategy: this.definition.strategy,
      task: options.task,
      traceId: options.traceContext?.traceId,
      updatedAt: timestamp,
    };
  }

  async writeInitialGraph(
    snapshot: ExpertWorkflowRunSnapshot,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.store.appendGraphRecord(
      snapshot.runId,
      {
        createdAt: snapshot.createdAt,
        definitionId: snapshot.definitionId,
        definitionVersion: snapshot.definitionVersion,
        phaseOrder: snapshot.phaseOrder,
        recordType: "meta",
        runId: snapshot.runId,
        schemaVersion: 1,
        strategy: snapshot.strategy,
      },
      { signal },
    );
    for (const node of snapshot.graph.nodes) {
      await this.store.appendGraphRecord(
        snapshot.runId,
        {
          node,
          recordType: "node",
          runId: snapshot.runId,
          timestamp: this.timestamp(),
        },
        { signal },
      );
    }
    for (const edge of snapshot.graph.edges) {
      await this.store.appendGraphRecord(
        snapshot.runId,
        {
          edge,
          recordType: "edge",
          runId: snapshot.runId,
          timestamp: this.timestamp(),
        },
        { signal },
      );
    }
    for (const collection of snapshot.graph.collections ?? []) {
      await this.store.appendGraphRecord(
        snapshot.runId,
        {
          collection,
          recordType: "collection",
          runId: snapshot.runId,
          timestamp: this.timestamp(),
        },
        { signal },
      );
    }
  }

  async appendGraphStatus(
    snapshot: ExpertWorkflowRunSnapshot,
    phase: string,
    status: WorkflowNodeStatus,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.appendGraphNodeStatus(snapshot, phaseNodeId(phase), status, signal, phase);
  }

  async appendGraphNodeStatus(
    snapshot: ExpertWorkflowRunSnapshot,
    nodeId: string,
    status: WorkflowNodeStatus,
    signal?: AbortSignal,
    phase?: string,
  ): Promise<void> {
    await this.store.appendGraphRecord(
      snapshot.runId,
      {
        nodeId,
        phase,
        recordType: "op",
        runId: snapshot.runId,
        status,
        timestamp: this.timestamp(),
        type: "update_status",
      },
      { signal },
    );
  }

  async appendEvent(
    runId: string,
    type: WorkflowEvent["type"],
    options: {
      message?: string;
      nodeId?: string;
      payload?: Record<string, unknown>;
      phase?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    const event: WorkflowEvent = {
      kind: this.definition.kind,
      message: options.message,
      nodeId: options.nodeId,
      payload: options.payload,
      phase: options.phase,
      runId,
      timestamp: this.timestamp(),
      type,
    };
    await this.store.appendEvent(event, { signal: options.signal });
    await this.onWorkflowEvent?.(event);
  }

  async appendLifecycleGraphChanges(
    snapshot: ExpertWorkflowRunSnapshot,
    nodeChanges: readonly WorkflowGraphNodeChange[],
    signal?: AbortSignal,
  ): Promise<void> {
    for (const change of nodeChanges) {
      await this.appendGraphNodeStatus(
        snapshot,
        change.nodeId,
        change.status,
        signal,
        change.phase,
      );
    }
  }

  updateSnapshot(
    snapshot: ExpertWorkflowRunSnapshot,
    patch: Partial<
      Pick<
        ExpertWorkflowRunSnapshot,
        | "completedAt"
        | "currentPhase"
        | "failure"
        | "pauseReason"
        | "recoveryActions"
        | "reportPath"
        | "startedAt"
        | "status"
      >
    >,
  ): ExpertWorkflowRunSnapshot {
    return {
      ...snapshot,
      ...patch,
      updatedAt: this.timestamp(),
    };
  }

  updatePhase(
    snapshot: ExpertWorkflowRunSnapshot,
    phase: string,
    patch: Partial<WorkflowPhaseSnapshot>,
  ): ExpertWorkflowRunSnapshot {
    return this.updateSnapshot(
      {
        ...snapshot,
        currentPhase: phase,
        graph: updateGraphNodeStatus(snapshot.graph, phase, patch.status),
        phases: snapshot.phases.map((item) =>
          item.phase === phase
            ? {
                ...item,
                ...patch,
              }
            : item,
        ),
      },
      {
        currentPhase: phase,
      },
    );
  }

  addArtifact(
    snapshot: ExpertWorkflowRunSnapshot,
    artifact: WorkflowArtifact,
  ): ExpertWorkflowRunSnapshot {
    const artifacts = [
      ...snapshot.artifacts.filter((item) => item.path !== artifact.path),
      artifact,
    ];
    return {
      ...snapshot,
      artifacts,
      updatedAt: this.timestamp(),
    };
  }

  upsertActivity(
    snapshot: ExpertWorkflowRunSnapshot,
    activity: WorkflowActivitySnapshot,
  ): ExpertWorkflowRunSnapshot {
    const activities = [
      ...snapshot.activities.filter((item) => item.activityId !== activity.activityId),
      activity,
    ];
    return {
      ...snapshot,
      activities,
      sessionLinks: deriveWorkflowSessionLinks({ activities, runId: snapshot.runId }),
      updatedAt: this.timestamp(),
    };
  }

  async resolveSnapshot(
    options: ExpertWorkflowLookupOptions,
  ): Promise<ExpertWorkflowRunSnapshot | null> {
    if (options.runId) {
      return await this.store.readRun(options.runId, { signal: options.abortSignal });
    }
    return await this.store.readLatestRun(
      {
        cwd: options.cwd,
        kind: this.definition.kind,
      },
      { signal: options.abortSignal },
    );
  }

  getPhaseDefinition(phase: string): WorkflowPhaseDefinition {
    const definition = this.phaseDefinitions.get(phase);
    if (!definition) {
      throw new Error(`${this.definition.title} definition is missing phase: ${phase}`);
    }
    return definition;
  }

  timestamp(): string {
    return this.now().toISOString();
  }

  registerRunAbortSignal(
    runId: string,
    externalSignal: AbortSignal | undefined,
  ): { dispose: () => void; signal: AbortSignal } {
    const controller = new AbortController();
    const forwardAbort = (): void => {
      controller.abort(
        externalSignal?.reason instanceof Error
          ? externalSignal.reason
          : new Error("Workflow aborted"),
      );
    };

    this.activeRunAbortControllers.set(runId, controller);
    if (externalSignal?.aborted) {
      forwardAbort();
    } else {
      externalSignal?.addEventListener("abort", forwardAbort, { once: true });
    }

    return {
      dispose: () => {
        externalSignal?.removeEventListener("abort", forwardAbort);
        if (this.activeRunAbortControllers.get(runId) === controller) {
          this.activeRunAbortControllers.delete(runId);
        }
      },
      signal: controller.signal,
    };
  }
}

export function lifecyclePayload(
  result: WorkflowSnapshotLifecycleResult<ExpertWorkflowRunSnapshot>,
): Record<string, unknown> {
  return {
    activityIds: result.activityIds,
    nodeIds: result.nodeChanges.map((change) => change.nodeId),
    phaseIds: result.phaseIds,
  };
}

export function compactWorkflowPayload(
  value: Record<string, unknown | undefined>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Record<string, unknown>;
}

export function dedupeWorkflowNodeChanges(
  changes: WorkflowGraphNodeChange[],
): WorkflowGraphNodeChange[] {
  const byNodeId = new Map<string, WorkflowGraphNodeChange>();
  for (const change of changes) {
    byNodeId.set(change.nodeId, change);
  }
  return [...byNodeId.values()];
}
