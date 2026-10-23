import { z } from "zod";
import {
  WorkflowActivityKindSchema,
  WorkflowArtifactSchema,
  WorkflowFailureSchema,
  WorkflowGraphCollectionStatusSchema,
  WorkflowKindSchema,
  WorkflowNodeStatusSchema,
  WorkflowPhaseIdSchema,
  WorkflowPhaseSnapshotSchema,
  WorkflowRecoveryActionSchema,
  WorkflowRunStatusSchema,
  WorkflowSessionLinkSchema,
  WorkflowStrategySchema,
} from "./base-schemas.js";

export const WorkflowActivitySnapshotSchema = z.object({
  activityId: z.string(),
  artifactPath: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  inputArtifactPaths: z.array(z.string()).default([]),
  kind: WorkflowActivityKindSchema,
  model: z.string().optional(),
  nodeId: z.string().optional(),
  outputArtifactPaths: z.array(z.string()).default([]),
  parentSessionId: z.string().optional(),
  phase: WorkflowPhaseIdSchema,
  sessionId: z.string().optional(),
  startedAt: z.string(),
  status: WorkflowNodeStatusSchema,
  traceId: z.string().optional(),
  turnId: z.string().optional(),
});
export type WorkflowActivitySnapshot = z.infer<typeof WorkflowActivitySnapshotSchema>;

export const WorkflowGraphNodeSchema = z.object({
  collectionId: z.string().optional(),
  id: z.string(),
  attempts: z.number().int().nonnegative().optional(),
  dependsOn: z.array(z.string()).default([]),
  description: z.string().optional(),
  error: z.string().optional(),
  kind: z.enum(["phase", "task"]).default("phase"),
  phase: WorkflowPhaseIdSchema.optional(),
  prompt: z.string().optional(),
  reopenAttempts: z.number().int().nonnegative().optional(),
  status: WorkflowNodeStatusSchema,
  title: z.string(),
});
export type WorkflowGraphNode = z.infer<typeof WorkflowGraphNodeSchema>;

export const WorkflowGraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
});
export type WorkflowGraphEdge = z.infer<typeof WorkflowGraphEdgeSchema>;

export const WorkflowGraphCollectionSchema = z.object({
  analyzedNodeIds: z.array(z.string()).optional(),
  collectionId: z.string(),
  errorCount: z.number().int().nonnegative().optional(),
  exhausted: z.boolean().optional(),
  explorable: z.boolean().optional(),
  frontierTarget: z.number().int().positive().optional(),
  goal: z.string().optional(),
  lastCompletionAt: z.string().optional(),
  lastGraphChangeAt: z.string().optional(),
  metric: z.string().optional(),
  nodeIds: z.array(z.string()).optional(),
  phase: WorkflowPhaseIdSchema.optional(),
  plannerRuns: z.number().int().nonnegative().optional(),
  status: WorkflowGraphCollectionStatusSchema.optional(),
  title: z.string().optional(),
});
export type WorkflowGraphCollection = z.infer<typeof WorkflowGraphCollectionSchema>;

export const WorkflowGraphSchema = z.object({
  collections: z.array(WorkflowGraphCollectionSchema).optional(),
  edges: z.array(WorkflowGraphEdgeSchema),
  nodes: z.array(WorkflowGraphNodeSchema),
});
export type WorkflowGraph = z.infer<typeof WorkflowGraphSchema>;

export const WorkflowGraphPlannerNodeSchema = z.object({
  collectionId: z.string().optional(),
  dependsOn: z.array(z.string()).default([]),
  description: z.string().optional(),
  id: z.string(),
  kind: z.enum(["phase", "task"]).default("task"),
  phase: WorkflowPhaseIdSchema.optional(),
  prompt: z.string().optional(),
  title: z.string(),
});
export type WorkflowGraphPlannerNode = z.infer<typeof WorkflowGraphPlannerNodeSchema>;

export const WorkflowGraphPlannerResultSchema = z.object({
  collectionNodeIds: z.array(z.string()).optional(),
  edges: z.array(WorkflowGraphEdgeSchema).default([]),
  exhausted: z.boolean().optional(),
  nodes: z.array(WorkflowGraphPlannerNodeSchema).default([]),
  reasoning: z.string().optional(),
});
export type WorkflowGraphPlannerResult = z.infer<typeof WorkflowGraphPlannerResultSchema>;

export const WorkflowGraphSeedCollectionSchema = z.object({
  collectionId: z.string(),
  explorable: z.boolean().optional(),
  frontierTarget: z.number().int().positive().optional(),
  goal: z.string().optional(),
  metric: z.string().optional(),
  nodeIds: z.array(z.string()).default([]),
  phase: WorkflowPhaseIdSchema.optional(),
  title: z.string().optional(),
});
export type WorkflowGraphSeedCollection = z.infer<typeof WorkflowGraphSeedCollectionSchema>;

export const WorkflowGraphSeedSchema = z.object({
  collections: z.array(WorkflowGraphSeedCollectionSchema).default([]),
  edges: z.array(WorkflowGraphEdgeSchema).default([]),
  nodes: z.array(WorkflowGraphPlannerNodeSchema).default([]),
  reasoning: z.string().optional(),
});
export type WorkflowGraphSeed = z.infer<typeof WorkflowGraphSeedSchema>;

export const WorkflowNodePromptUpdateSchema = z
  .object({
    description: z.string().min(1).optional(),
    id: z.string().min(1),
    prompt: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
  })
  .refine(
    (update) =>
      update.description !== undefined || update.prompt !== undefined || update.title !== undefined,
    {
      message: "Workflow node prompt update must include prompt, description, or title",
    },
  );
export type WorkflowNodePromptUpdate = z.infer<typeof WorkflowNodePromptUpdateSchema>;

export const WorkflowNodePromptUpdateSetSchema = z.object({
  nodes: z.array(WorkflowNodePromptUpdateSchema).default([]),
  reasoning: z.string().optional(),
});
export type WorkflowNodePromptUpdateSet = z.infer<typeof WorkflowNodePromptUpdateSetSchema>;

export const WorkflowCriticSeveritySchema = z.enum(["critical", "major", "minor"]);
export type WorkflowCriticSeverity = z.infer<typeof WorkflowCriticSeveritySchema>;

export const WorkflowCriticReopenProposalSchema = z.object({
  nodeId: z.string().min(1),
  reason: z.string().min(1),
  severity: WorkflowCriticSeveritySchema.optional(),
});
export type WorkflowCriticReopenProposal = z.infer<typeof WorkflowCriticReopenProposalSchema>;

export const WorkflowCriticResultSchema = z.object({
  acceptanceGaps: z.array(z.string()).default([]),
  reasoning: z.string().default(""),
  reopenProposals: z.array(WorkflowCriticReopenProposalSchema).default([]),
  verdict: z.enum(["pass", "fail"]),
});
export type WorkflowCriticResult = z.infer<typeof WorkflowCriticResultSchema>;

export const WorkflowRunSnapshotSchema = z.object({
  activities: z.array(WorkflowActivitySnapshotSchema).default([]),
  artifacts: z.array(WorkflowArtifactSchema),
  completedAt: z.string().optional(),
  createdAt: z.string(),
  currentPhase: WorkflowPhaseIdSchema.optional(),
  cwd: z.string(),
  definitionId: z.string().min(1).optional(),
  definitionVersion: z.string().min(1).optional(),
  graph: WorkflowGraphSchema,
  kind: WorkflowKindSchema,
  phaseOrder: z.array(WorkflowPhaseIdSchema),
  phases: z.array(WorkflowPhaseSnapshotSchema),
  failure: WorkflowFailureSchema.optional(),
  pauseReason: z.string().optional(),
  reportPath: z.string().optional(),
  recoveryActions: z.array(WorkflowRecoveryActionSchema).default([]),
  runId: z.string(),
  schemaVersion: z.literal(1),
  sessionId: z.string().optional(),
  sessionLinks: z.array(WorkflowSessionLinkSchema).default([]),
  startedAt: z.string().optional(),
  status: WorkflowRunStatusSchema,
  strategy: WorkflowStrategySchema,
  task: z.string(),
  traceId: z.string().optional(),
  updatedAt: z.string(),
});
export type WorkflowRunSnapshot = z.infer<typeof WorkflowRunSnapshotSchema>;

export const WorkflowEventTypeSchema = z.enum([
  "run_started",
  "run_completed",
  "run_failed",
  "workflow_paused",
  "workflow_retry_started",
  "workflow_session_linked",
  "run_cancelled",
  "phase_started",
  "phase_completed",
  "phase_failed",
  "artifact_written",
  "graph_updated",
  "node_started",
  "node_completed",
  "node_failed",
  "frontier_changed",
  "executor_paused",
  "executor_completed",
  "planner_started",
  "planner_completed",
  "planner_failed",
  "graph_expanded",
  "collection_exhausted",
  "critic_started",
  "critic_passed",
  "critic_failed",
  "node_reopened",
  "critic_iteration_limit_reached",
]);
export type WorkflowEventType = z.infer<typeof WorkflowEventTypeSchema>;

export const WorkflowEventSchema = z.object({
  kind: WorkflowKindSchema,
  message: z.string().optional(),
  nodeId: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
  phase: WorkflowPhaseIdSchema.optional(),
  runId: z.string(),
  timestamp: z.string(),
  type: WorkflowEventTypeSchema,
});
export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;

export const WorkflowGraphRecordSchema = z.discriminatedUnion("recordType", [
  z.object({
    recordType: z.literal("meta"),
    createdAt: z.string(),
    definitionId: z.string().min(1).optional(),
    definitionVersion: z.string().min(1).optional(),
    phaseOrder: z.array(WorkflowPhaseIdSchema),
    runId: z.string(),
    schemaVersion: z.literal(1),
    strategy: WorkflowStrategySchema,
  }),
  z.object({
    recordType: z.literal("node"),
    node: WorkflowGraphNodeSchema,
    runId: z.string(),
    timestamp: z.string(),
  }),
  z.object({
    recordType: z.literal("edge"),
    edge: WorkflowGraphEdgeSchema,
    runId: z.string(),
    timestamp: z.string(),
  }),
  z.object({
    recordType: z.literal("collection"),
    collection: WorkflowGraphCollectionSchema,
    runId: z.string(),
    timestamp: z.string(),
  }),
  z.object({
    collectionId: z.string().optional(),
    edgeIds: z.array(z.string()).optional(),
    recordType: z.literal("op"),
    nodeId: z.string().optional(),
    nodeIds: z.array(z.string()).optional(),
    phase: WorkflowPhaseIdSchema.optional(),
    payload: z.record(z.unknown()).optional(),
    runId: z.string(),
    status: WorkflowNodeStatusSchema.optional(),
    timestamp: z.string(),
    type: z.string(),
  }),
]);
export type WorkflowGraphRecord = z.infer<typeof WorkflowGraphRecordSchema>;

export const WorkflowSchedulerDerivedNodeSchema = z.object({
  blockedBy: z.array(z.string()),
  collectionIds: z.array(z.string()).default([]),
  incoming: z.array(z.string()),
  node: WorkflowGraphNodeSchema,
  outgoing: z.array(z.string()),
  ready: z.boolean(),
});
export type WorkflowSchedulerDerivedNode = z.infer<typeof WorkflowSchedulerDerivedNodeSchema>;

export const WorkflowSchedulerCollectionStateSchema = z.object({
  activeNodeIds: z.array(z.string()),
  collection: WorkflowGraphCollectionSchema,
  completedNodeIds: z.array(z.string()),
  errorCount: z.number().int().nonnegative(),
  exhausted: z.boolean(),
  failedNodeIds: z.array(z.string()),
  frontier: z.number().int().nonnegative(),
  frontierTarget: z.number().int().positive().optional(),
  pendingNodeIds: z.array(z.string()),
  plannerRuns: z.number().int().nonnegative(),
  readyNodeIds: z.array(z.string()),
  status: WorkflowGraphCollectionStatusSchema,
});
export type WorkflowSchedulerCollectionState = z.infer<
  typeof WorkflowSchedulerCollectionStateSchema
>;

export const WorkflowSchedulerActiveActivitySchema = z.object({
  activityId: z.string(),
  nodeId: z.string().optional(),
  phase: WorkflowPhaseIdSchema,
  sessionId: z.string().optional(),
  traceId: z.string().optional(),
  turnId: z.string().optional(),
});
export type WorkflowSchedulerActiveActivity = z.infer<typeof WorkflowSchedulerActiveActivitySchema>;

export const WorkflowSchedulerStateSchema = z.object({
  activeActivities: z.array(WorkflowSchedulerActiveActivitySchema),
  activeChildSessionIds: z.array(z.string()),
  activeNodeIds: z.array(z.string()),
  blockedNodes: z.array(
    z.object({
      blockedBy: z.array(z.string()),
      nodeId: z.string(),
    }),
  ),
  counts: z.object({
    active: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  collectionStates: z.array(WorkflowSchedulerCollectionStateSchema).default([]),
  nodes: z.array(WorkflowSchedulerDerivedNodeSchema),
  readyNodeIds: z.array(z.string()),
});
export type WorkflowSchedulerState = z.infer<typeof WorkflowSchedulerStateSchema>;
