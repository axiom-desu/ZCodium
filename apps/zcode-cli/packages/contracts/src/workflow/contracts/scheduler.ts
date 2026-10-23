import type {
  WorkflowNodeStatus,
  WorkflowSessionLink,
  WorkflowSessionLinkStatus,
} from "./base-schemas.js";
import type { WorkflowGraph, WorkflowRunSnapshot, WorkflowSchedulerState } from "./definitions.js";

const TERMINAL_DEPENDENCY_STATUSES = new Set<WorkflowNodeStatus>([
  "cancelled",
  "completed",
  "failed",
  "skipped",
]);

export function deriveWorkflowSchedulerState(graph: WorkflowGraph): WorkflowSchedulerState {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const incomingById = new Map<string, string[]>();
  const outgoingById = new Map<string, string[]>();

  for (const node of graph.nodes) {
    incomingById.set(node.id, [...node.dependsOn]);
    outgoingById.set(node.id, []);
  }

  for (const edge of graph.edges) {
    incomingById.set(edge.to, [...(incomingById.get(edge.to) ?? []), edge.from]);
    outgoingById.set(edge.from, [...(outgoingById.get(edge.from) ?? []), edge.to]);
  }

  const collections = graph.collections ?? [];
  const collectionIdsByNodeId = new Map<string, string[]>();
  for (const collection of collections) {
    for (const nodeId of collection.nodeIds ?? []) {
      const collectionIds = collectionIdsByNodeId.get(nodeId) ?? [];
      collectionIds.push(collection.collectionId);
      collectionIdsByNodeId.set(nodeId, collectionIds);
    }
  }
  for (const node of graph.nodes) {
    if (!node.collectionId) continue;
    const collectionIds = collectionIdsByNodeId.get(node.id) ?? [];
    if (!collectionIds.includes(node.collectionId)) {
      collectionIds.push(node.collectionId);
      collectionIdsByNodeId.set(node.id, collectionIds);
    }
  }

  const nodes = graph.nodes.map((node) => {
    const incoming = [...new Set(incomingById.get(node.id) ?? [])];
    const blockedBy = incoming.filter((dependencyId) => {
      const dependency = nodesById.get(dependencyId);
      return !dependency || !TERMINAL_DEPENDENCY_STATUSES.has(dependency.status);
    });
    return {
      blockedBy,
      collectionIds: collectionIdsByNodeId.get(node.id) ?? [],
      incoming,
      node,
      outgoing: [...new Set(outgoingById.get(node.id) ?? [])],
      ready: node.status === "pending" && blockedBy.length === 0,
    };
  });

  const activeNodeIds = nodes
    .filter((entry) => entry.node.status === "active")
    .map((entry) => entry.node.id);
  const blockedNodes = nodes
    .filter((entry) => entry.node.status === "pending" && entry.blockedBy.length > 0)
    .map((entry) => ({ blockedBy: entry.blockedBy, nodeId: entry.node.id }));
  const readyNodeIds = nodes.filter((entry) => entry.ready).map((entry) => entry.node.id);
  const collectionStates = collections.map((collection) => {
    const nodeIds = [
      ...new Set([
        ...(collection.nodeIds ?? []),
        ...graph.nodes
          .filter((node) => node.collectionId === collection.collectionId)
          .map((node) => node.id),
      ]),
    ];
    const activeCollectionNodeIds = nodeIds.filter(
      (nodeId) => nodesById.get(nodeId)?.status === "active",
    );
    const pendingNodeIds = nodeIds.filter((nodeId) => nodesById.get(nodeId)?.status === "pending");
    const completedNodeIds = nodeIds.filter(
      (nodeId) => nodesById.get(nodeId)?.status === "completed",
    );
    const failedNodeIds = nodeIds.filter((nodeId) => nodesById.get(nodeId)?.status === "failed");
    const readyCollectionNodeIds = readyNodeIds.filter((nodeId) => nodeIds.includes(nodeId));
    return {
      activeNodeIds: activeCollectionNodeIds,
      collection,
      completedNodeIds,
      errorCount: collection.errorCount ?? 0,
      exhausted: collection.exhausted ?? false,
      failedNodeIds,
      frontier: activeCollectionNodeIds.length + pendingNodeIds.length,
      frontierTarget: collection.frontierTarget,
      pendingNodeIds,
      plannerRuns: collection.plannerRuns ?? 0,
      readyNodeIds: readyCollectionNodeIds,
      status: collection.status ?? "active",
    };
  });

  return {
    activeActivities: [],
    activeChildSessionIds: [],
    activeNodeIds,
    blockedNodes,
    counts: {
      active: activeNodeIds.length,
      blocked: blockedNodes.length,
      completed: nodes.filter((entry) => entry.node.status === "completed").length,
      failed: nodes.filter((entry) => entry.node.status === "failed").length,
      pending: nodes.filter((entry) => entry.node.status === "pending").length,
      ready: readyNodeIds.length,
      total: nodes.length,
    },
    collectionStates,
    nodes,
    readyNodeIds,
  };
}

export function deriveWorkflowRunSchedulerState(
  snapshot: WorkflowRunSnapshot,
): WorkflowSchedulerState {
  const state = deriveWorkflowSchedulerState(snapshot.graph);
  const activeActivities = snapshot.activities
    .filter((activity) => activity.status === "active")
    .map((activity) => ({
      activityId: activity.activityId,
      ...(activity.nodeId ? { nodeId: activity.nodeId } : {}),
      phase: activity.phase,
      ...(activity.sessionId ? { sessionId: activity.sessionId } : {}),
      ...(activity.traceId ? { traceId: activity.traceId } : {}),
      ...(activity.turnId ? { turnId: activity.turnId } : {}),
    }));

  return {
    ...state,
    activeActivities,
    activeChildSessionIds: activeActivities
      .map((activity) => activity.sessionId)
      .filter((sessionId): sessionId is string => sessionId !== undefined),
  };
}

export function deriveWorkflowSessionLinks(
  snapshot: Pick<WorkflowRunSnapshot, "activities" | "runId">,
): WorkflowSessionLink[] {
  const attemptByScope = new Map<string, number>();
  return snapshot.activities.map((activity) => {
    const scope = [
      activity.phase,
      activity.nodeId ?? `phase:${activity.phase}`,
      activity.kind,
    ].join(":");
    const attempt = (attemptByScope.get(scope) ?? 0) + 1;
    attemptByScope.set(scope, attempt);
    return {
      activityId: activity.activityId,
      attempt,
      ...(activity.completedAt ? { completedAt: activity.completedAt } : {}),
      kind: activity.kind,
      ...(activity.model ? { model: activity.model } : {}),
      ...(activity.nodeId ? { nodeId: activity.nodeId } : {}),
      ...(activity.parentSessionId ? { parentSessionId: activity.parentSessionId } : {}),
      phase: activity.phase,
      runId: snapshot.runId,
      ...(activity.sessionId ? { sessionId: activity.sessionId } : {}),
      startedAt: activity.startedAt,
      status: workflowSessionLinkStatusFromActivity(activity.status),
      ...(activity.traceId ? { traceId: activity.traceId } : {}),
      ...(activity.turnId ? { turnId: activity.turnId } : {}),
    };
  });
}

function workflowSessionLinkStatusFromActivity(
  status: WorkflowNodeStatus,
): WorkflowSessionLinkStatus {
  switch (status) {
    case "active":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "skipped":
      return "cancelled";
    case "pending":
    default:
      return "starting";
  }
}
