// Workflow snapshot 生命周期的公开选项与结果类型（保持 lifecycle.ts 原有导出面）。

import type {
  WorkflowGraphCollection,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowNodeStatus,
  WorkflowRunSnapshot,
} from "@zcode/contracts";

export interface WorkflowGraphNodeChange {
  nodeId: string;
  phase?: string;
  status: WorkflowNodeStatus;
}

export interface WorkflowSnapshotLifecycleResult<TSnapshot extends WorkflowRunSnapshot> {
  activityIds: string[];
  changed: boolean;
  nodeChanges: WorkflowGraphNodeChange[];
  phaseIds: string[];
  snapshot: TSnapshot;
}

export interface ReconcileWorkflowSnapshotForResumeOptions {
  nodeIds?: Iterable<string>;
  reason?: string;
  resetActivities?: boolean;
  resetPhases?: boolean;
  timestamp: string;
}

export interface CancelWorkflowSnapshotOptions {
  reason?: string;
  timestamp: string;
}

export interface ReopenWorkflowGraphNodeOptions {
  maxReopens?: number;
  nodeId: string;
  reason?: string;
  timestamp: string;
}

export interface ReopenWorkflowGraphNodeResult<TSnapshot extends WorkflowRunSnapshot> {
  changed: boolean;
  nodeChange: WorkflowGraphNodeChange;
  reopenAttempts: number;
  snapshot: TSnapshot;
}

export interface ApplyWorkflowGraphSeedOptions {
  phase?: string;
  timestamp: string;
}

export interface ApplyWorkflowGraphSeedResult<TSnapshot extends WorkflowRunSnapshot> {
  addedCollections: WorkflowGraphCollection[];
  addedEdges: WorkflowGraphEdge[];
  addedNodes: WorkflowGraphNode[];
  changed: boolean;
  snapshot: TSnapshot;
}

export interface ApplyWorkflowNodePromptUpdatesOptions {
  phase: string;
  timestamp: string;
}

export interface ApplyWorkflowNodePromptUpdatesResult<TSnapshot extends WorkflowRunSnapshot> {
  changed: boolean;
  snapshot: TSnapshot;
  updatedNodes: WorkflowGraphNode[];
}
