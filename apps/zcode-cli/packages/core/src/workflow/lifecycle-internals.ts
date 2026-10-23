// Workflow snapshot 生命周期的纯转换：节点/相位/活动的局部状态改写与 seed 边校验。
// 快照归属仍是调用方，这里只返回新对象，不持有状态。

import type {
  WorkflowActivitySnapshot,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowNodeStatus,
  WorkflowPhaseSnapshot,
} from "@zcode/contracts";
import type { WorkflowGraphNodeChange } from "./lifecycle-types.js";

export function isInScope(value: string, scope: ReadonlySet<string> | undefined): boolean {
  return !scope || scope.has(value);
}

export function shouldRepairPhase(
  phase: string,
  nodeScope: ReadonlySet<string> | undefined,
  resetPhaseIdsFromNodes: ReadonlySet<string>,
): boolean {
  if (!nodeScope) return true;
  return resetPhaseIdsFromNodes.has(phase);
}

export function shouldRepairActivity(
  activity: WorkflowActivitySnapshot,
  nodeScope: ReadonlySet<string> | undefined,
  resetPhaseIdsFromNodes: ReadonlySet<string>,
): boolean {
  if (!nodeScope) return true;
  if (activity.nodeId && nodeScope.has(activity.nodeId)) return true;
  return resetPhaseIdsFromNodes.has(activity.phase);
}

export function nodeChange(
  node: WorkflowGraphNode,
  status: WorkflowNodeStatus,
): WorkflowGraphNodeChange {
  return {
    nodeId: node.id,
    ...(node.phase ? { phase: node.phase } : {}),
    status,
  };
}

export function resetPhaseForRetry(
  phase: WorkflowPhaseSnapshot,
  reason: string,
): WorkflowPhaseSnapshot {
  return {
    error: reason,
    phase: phase.phase,
    status: "pending",
  };
}

export function closePhase(
  phase: WorkflowPhaseSnapshot,
  status: WorkflowNodeStatus,
  timestamp: string,
  reason: string,
): WorkflowPhaseSnapshot {
  return {
    ...phase,
    completedAt: phase.completedAt ?? timestamp,
    error: phase.error ?? reason,
    status,
  };
}

export function closeActivity(
  activity: WorkflowActivitySnapshot,
  status: WorkflowNodeStatus,
  timestamp: string,
  reason: string,
): WorkflowActivitySnapshot {
  return {
    ...activity,
    completedAt: activity.completedAt ?? timestamp,
    error: activity.error ?? reason,
    status,
  };
}

export function normalizeSeedEdges(
  existingEdges: readonly WorkflowGraphEdge[],
  addedNodes: readonly WorkflowGraphNode[],
  seedEdges: readonly WorkflowGraphEdge[],
): WorkflowGraphEdge[] {
  const edges = seedEdges.map((edge) => ({ from: edge.from, to: edge.to }));
  const knownEdgeIds = new Set([...existingEdges, ...edges].map(edgeId));
  for (const node of addedNodes) {
    for (const dependencyId of node.dependsOn) {
      const edge = { from: dependencyId, to: node.id };
      const id = edgeId(edge);
      if (knownEdgeIds.has(id)) continue;
      edges.push(edge);
      knownEdgeIds.add(id);
    }
  }
  return edges;
}

export function validateAddedEdges(
  existingNodes: readonly WorkflowGraphNode[],
  existingEdges: readonly WorkflowGraphEdge[],
  addedNodes: readonly WorkflowGraphNode[],
  addedEdges: readonly WorkflowGraphEdge[],
): void {
  const nodeIds = new Set([...existingNodes, ...addedNodes].map((node) => node.id));
  const seenEdgeIds = new Set(existingEdges.map(edgeId));
  const pendingEdges = [...existingEdges];
  for (const edge of addedEdges) {
    if (edge.from === edge.to) {
      throw new Error(`Workflow graph seed returned a self-loop edge: ${edge.from} -> ${edge.to}`);
    }
    if (!nodeIds.has(edge.from)) {
      throw new Error(
        `Workflow graph seed returned an edge with unknown source node: ${edge.from}`,
      );
    }
    if (!nodeIds.has(edge.to)) {
      throw new Error(`Workflow graph seed returned an edge with unknown target node: ${edge.to}`);
    }
    const id = edgeId(edge);
    if (seenEdgeIds.has(id)) {
      throw new Error(`Workflow graph seed returned duplicate edge: ${id}`);
    }
    if (wouldFormCycle(pendingEdges, edge)) {
      throw new Error(`Workflow graph seed returned an edge that would create a cycle: ${id}`);
    }
    seenEdgeIds.add(id);
    pendingEdges.push(edge);
  }
}

function wouldFormCycle(edges: readonly WorkflowGraphEdge[], newEdge: WorkflowGraphEdge): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }

  const visited = new Set<string>();
  const queue = [newEdge.to];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === newEdge.from) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...(outgoing.get(current) ?? []));
  }
  return false;
}

function edgeId(edge: WorkflowGraphEdge): string {
  return `${edge.from}->${edge.to}`;
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
