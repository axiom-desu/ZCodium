import {
  deriveWorkflowSessionLinks,
  type WorkflowGraphCollection,
  type WorkflowGraphNode,
  type WorkflowGraphSeed,
  WorkflowGraphSeedSchema,
  type WorkflowNodePromptUpdate,
  WorkflowNodePromptUpdateSetSchema,
  type WorkflowNodeStatus,
  type WorkflowRunSnapshot,
} from "@zcode/contracts";
import {
  closeActivity,
  closePhase,
  isInScope,
  nodeChange,
  normalizeSeedEdges,
  resetPhaseForRetry,
  shouldRepairActivity,
  shouldRepairPhase,
  uniqueStrings,
  validateAddedEdges,
} from "./lifecycle-internals.js";
import type {
  ApplyWorkflowGraphSeedOptions,
  ApplyWorkflowGraphSeedResult,
  ApplyWorkflowNodePromptUpdatesOptions,
  ApplyWorkflowNodePromptUpdatesResult,
  CancelWorkflowSnapshotOptions,
  ReconcileWorkflowSnapshotForResumeOptions,
  ReopenWorkflowGraphNodeOptions,
  ReopenWorkflowGraphNodeResult,
  WorkflowGraphNodeChange,
  WorkflowSnapshotLifecycleResult,
} from "./lifecycle-types.js";

export type {
  ApplyWorkflowGraphSeedOptions,
  ApplyWorkflowGraphSeedResult,
  ApplyWorkflowNodePromptUpdatesOptions,
  ApplyWorkflowNodePromptUpdatesResult,
  CancelWorkflowSnapshotOptions,
  ReconcileWorkflowSnapshotForResumeOptions,
  ReopenWorkflowGraphNodeOptions,
  ReopenWorkflowGraphNodeResult,
  WorkflowGraphNodeChange,
  WorkflowSnapshotLifecycleResult,
} from "./lifecycle-types.js";

const DEFAULT_RESUME_RESET_REASON =
  "Reset during workflow resume because the previous process stopped before completion.";
const DEFAULT_CANCEL_REASON = "Workflow cancelled.";
const DEFAULT_REOPEN_REASON = "Reopened by workflow critic.";
const CANCELLABLE_STATUSES = new Set<WorkflowNodeStatus>(["active", "pending"]);
const REOPENABLE_STATUSES = new Set<WorkflowNodeStatus>(["completed", "failed", "skipped"]);

export function reconcileWorkflowSnapshotForResume<TSnapshot extends WorkflowRunSnapshot>(
  snapshot: TSnapshot,
  options: ReconcileWorkflowSnapshotForResumeOptions,
): WorkflowSnapshotLifecycleResult<TSnapshot> {
  const reason = options.reason ?? DEFAULT_RESUME_RESET_REASON;
  const nodeScope = options.nodeIds ? new Set(options.nodeIds) : undefined;
  const resetActivities = options.resetActivities ?? true;
  const resetPhases = options.resetPhases ?? true;
  const nodeChanges: WorkflowGraphNodeChange[] = [];
  const resetPhaseIdsFromNodes = new Set<string>();

  const nodes = snapshot.graph.nodes.map((node) => {
    if (node.status !== "active" || !isInScope(node.id, nodeScope)) {
      return node;
    }
    nodeChanges.push(nodeChange(node, "pending"));
    if (node.phase) {
      resetPhaseIdsFromNodes.add(node.phase);
    }
    return {
      ...node,
      error: reason,
      status: "pending" as const,
    };
  });

  const phaseIds: string[] = [];
  const phases = snapshot.phases.map((phase) => {
    if (
      !resetPhases ||
      phase.status !== "active" ||
      !shouldRepairPhase(phase.phase, nodeScope, resetPhaseIdsFromNodes)
    ) {
      return phase;
    }
    phaseIds.push(phase.phase);
    return resetPhaseForRetry(phase, reason);
  });

  const activityIds: string[] = [];
  const activities = snapshot.activities.map((activity) => {
    if (
      !resetActivities ||
      activity.status !== "active" ||
      !shouldRepairActivity(activity, nodeScope, resetPhaseIdsFromNodes)
    ) {
      return activity;
    }
    activityIds.push(activity.activityId);
    return closeActivity(activity, "cancelled", options.timestamp, reason);
  });

  const changed = nodeChanges.length > 0 || phaseIds.length > 0 || activityIds.length > 0;
  return {
    activityIds,
    changed,
    nodeChanges,
    phaseIds,
    snapshot: changed
      ? ({
          ...snapshot,
          activities,
          graph: {
            collections: snapshot.graph.collections,
            edges: snapshot.graph.edges,
            nodes,
          },
          phases,
          sessionLinks: deriveWorkflowSessionLinks({ activities, runId: snapshot.runId }),
          updatedAt: options.timestamp,
        } as TSnapshot)
      : snapshot,
  };
}

export function cancelWorkflowSnapshot<TSnapshot extends WorkflowRunSnapshot>(
  snapshot: TSnapshot,
  options: CancelWorkflowSnapshotOptions,
): WorkflowSnapshotLifecycleResult<TSnapshot> {
  const reason = options.reason ?? DEFAULT_CANCEL_REASON;
  const nodeChanges: WorkflowGraphNodeChange[] = [];

  const nodes = snapshot.graph.nodes.map((node) => {
    if (!CANCELLABLE_STATUSES.has(node.status)) {
      return node;
    }
    nodeChanges.push(nodeChange(node, "cancelled"));
    return {
      ...node,
      error: reason,
      status: "cancelled" as const,
    };
  });

  const phaseIds: string[] = [];
  const phases = snapshot.phases.map((phase) => {
    if (!CANCELLABLE_STATUSES.has(phase.status)) {
      return phase;
    }
    phaseIds.push(phase.phase);
    return closePhase(phase, "cancelled", options.timestamp, reason);
  });

  const activityIds: string[] = [];
  const activities = snapshot.activities.map((activity) => {
    if (!CANCELLABLE_STATUSES.has(activity.status)) {
      return activity;
    }
    activityIds.push(activity.activityId);
    return closeActivity(activity, "cancelled", options.timestamp, reason);
  });

  const changed =
    snapshot.status !== "cancelled" ||
    snapshot.completedAt !== options.timestamp ||
    nodeChanges.length > 0 ||
    phaseIds.length > 0 ||
    activityIds.length > 0;

  return {
    activityIds,
    changed,
    nodeChanges,
    phaseIds,
    snapshot: changed
      ? ({
          ...snapshot,
          activities,
          completedAt: options.timestamp,
          graph: {
            collections: snapshot.graph.collections,
            edges: snapshot.graph.edges,
            nodes,
          },
          phases,
          sessionLinks: deriveWorkflowSessionLinks({ activities, runId: snapshot.runId }),
          status: "cancelled",
          updatedAt: options.timestamp,
        } as TSnapshot)
      : snapshot,
  };
}

export function reopenWorkflowGraphNode<TSnapshot extends WorkflowRunSnapshot>(
  snapshot: TSnapshot,
  options: ReopenWorkflowGraphNodeOptions,
): ReopenWorkflowGraphNodeResult<TSnapshot> {
  const node = snapshot.graph.nodes.find((item) => item.id === options.nodeId);
  if (!node) {
    throw new Error(`Workflow graph node not found: ${options.nodeId}`);
  }
  if (!REOPENABLE_STATUSES.has(node.status)) {
    throw new Error(
      `Cannot reopen workflow node "${options.nodeId}": status is "${node.status}", expected completed, failed, or skipped`,
    );
  }

  const maxReopens = options.maxReopens ?? 2;
  const reopenAttempts = node.reopenAttempts ?? 0;
  if (reopenAttempts >= maxReopens) {
    throw new Error(
      `Workflow node "${options.nodeId}" already reopened ${reopenAttempts}x (max=${maxReopens})`,
    );
  }

  const nextAttempts = reopenAttempts + 1;
  const reason = options.reason ?? DEFAULT_REOPEN_REASON;
  const nodes = snapshot.graph.nodes.map((item) =>
    item.id === options.nodeId
      ? {
          ...item,
          error: reason,
          reopenAttempts: nextAttempts,
          status: "pending" as const,
        }
      : item,
  );

  return {
    changed: true,
    nodeChange: nodeChange(node, "pending"),
    reopenAttempts: nextAttempts,
    snapshot: {
      ...snapshot,
      graph: {
        collections: snapshot.graph.collections,
        edges: snapshot.graph.edges,
        nodes,
      },
      updatedAt: options.timestamp,
    } as TSnapshot,
  };
}

export function applyWorkflowGraphSeed<TSnapshot extends WorkflowRunSnapshot>(
  snapshot: TSnapshot,
  seed: WorkflowGraphSeed,
  options: ApplyWorkflowGraphSeedOptions,
): ApplyWorkflowGraphSeedResult<TSnapshot> {
  const parsedSeed = WorkflowGraphSeedSchema.parse(seed);
  const existingNodeIds = new Set(snapshot.graph.nodes.map((node) => node.id));
  const addedNodes: WorkflowGraphNode[] = [];
  const pendingNodeIds = new Set<string>();

  for (const node of parsedSeed.nodes) {
    if (existingNodeIds.has(node.id) || pendingNodeIds.has(node.id)) {
      throw new Error(`Workflow graph seed returned duplicate node: ${node.id}`);
    }
    pendingNodeIds.add(node.id);
    addedNodes.push({
      collectionId: node.collectionId,
      dependsOn: uniqueStrings(node.dependsOn ?? []),
      description: node.description,
      id: node.id,
      kind: node.kind ?? "task",
      phase: node.phase ?? options.phase,
      prompt: node.prompt,
      status: "pending",
      title: node.title,
    });
  }

  const addedEdges = normalizeSeedEdges(snapshot.graph.edges, addedNodes, parsedSeed.edges);
  validateAddedEdges(snapshot.graph.nodes, snapshot.graph.edges, addedNodes, addedEdges);

  const knownNodeIds = new Set([
    ...snapshot.graph.nodes.map((node) => node.id),
    ...addedNodes.map((node) => node.id),
  ]);
  const existingCollectionIds = new Set(
    (snapshot.graph.collections ?? []).map((collection) => collection.collectionId),
  );
  const addedCollections: WorkflowGraphCollection[] = [];
  const pendingCollectionIds = new Set<string>();
  for (const collection of parsedSeed.collections) {
    if (
      existingCollectionIds.has(collection.collectionId) ||
      pendingCollectionIds.has(collection.collectionId)
    ) {
      throw new Error(
        `Workflow graph seed returned duplicate collection: ${collection.collectionId}`,
      );
    }
    pendingCollectionIds.add(collection.collectionId);
    const implicitNodeIds = addedNodes
      .filter((node) => node.collectionId === collection.collectionId)
      .map((node) => node.id);
    const nodeIds = uniqueStrings([...(collection.nodeIds ?? []), ...implicitNodeIds]);
    for (const nodeId of nodeIds) {
      if (!knownNodeIds.has(nodeId)) {
        throw new Error(
          `Workflow graph seed collection "${collection.collectionId}" references unknown node: ${nodeId}`,
        );
      }
    }
    addedCollections.push({
      collectionId: collection.collectionId,
      explorable: collection.explorable,
      frontierTarget: collection.frontierTarget,
      goal: collection.goal,
      metric: collection.metric,
      nodeIds,
      phase: collection.phase ?? options.phase,
      title: collection.title,
    });
  }

  const changed = addedNodes.length > 0 || addedEdges.length > 0 || addedCollections.length > 0;
  return {
    addedCollections,
    addedEdges,
    addedNodes,
    changed,
    snapshot: changed
      ? ({
          ...snapshot,
          graph: {
            collections: [...(snapshot.graph.collections ?? []), ...addedCollections],
            edges: [...snapshot.graph.edges, ...addedEdges],
            nodes: [...snapshot.graph.nodes, ...addedNodes],
          },
          updatedAt: options.timestamp,
        } as TSnapshot)
      : snapshot,
  };
}

export function applyWorkflowNodePromptUpdates<TSnapshot extends WorkflowRunSnapshot>(
  snapshot: TSnapshot,
  updates: readonly WorkflowNodePromptUpdate[],
  options: ApplyWorkflowNodePromptUpdatesOptions,
): ApplyWorkflowNodePromptUpdatesResult<TSnapshot> {
  const parsedUpdates = WorkflowNodePromptUpdateSetSchema.parse({ nodes: updates }).nodes;
  const updatesByNodeId = new Map<string, WorkflowNodePromptUpdate>();
  for (const update of parsedUpdates) {
    if (updatesByNodeId.has(update.id)) {
      throw new Error(`Workflow node prompt update returned duplicate node: ${update.id}`);
    }
    updatesByNodeId.set(update.id, update);
  }
  if (updatesByNodeId.size === 0) {
    return { changed: false, snapshot, updatedNodes: [] };
  }

  const nodeIds = new Set(snapshot.graph.nodes.map((node) => node.id));
  for (const nodeId of updatesByNodeId.keys()) {
    if (!nodeIds.has(nodeId)) {
      throw new Error(`Workflow node prompt update references unknown node: ${nodeId}`);
    }
  }

  const updatedNodes: WorkflowGraphNode[] = [];
  const nodes = snapshot.graph.nodes.map((node) => {
    const update = updatesByNodeId.get(node.id);
    if (!update) return node;
    if (node.phase !== undefined && node.phase !== options.phase) {
      throw new Error(
        `Workflow node prompt update for "${node.id}" targets phase "${options.phase}" but node belongs to "${node.phase}"`,
      );
    }

    const nextNode: WorkflowGraphNode = {
      ...node,
      description: update.description ?? node.description,
      prompt: update.prompt ?? node.prompt,
      title: update.title ?? node.title,
    };
    if (
      nextNode.description === node.description &&
      nextNode.prompt === node.prompt &&
      nextNode.title === node.title
    ) {
      return node;
    }
    updatedNodes.push(nextNode);
    return nextNode;
  });

  if (updatedNodes.length === 0) {
    return { changed: false, snapshot, updatedNodes: [] };
  }

  return {
    changed: true,
    snapshot: {
      ...snapshot,
      graph: {
        collections: snapshot.graph.collections,
        edges: snapshot.graph.edges,
        nodes,
      },
      updatedAt: options.timestamp,
    } as TSnapshot,
    updatedNodes,
  };
}
