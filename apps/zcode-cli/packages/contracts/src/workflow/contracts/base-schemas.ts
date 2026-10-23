import { z } from "zod";

export const WorkflowKindSchema = z.string().min(1);
export type WorkflowKind = z.infer<typeof WorkflowKindSchema>;

export const WorkflowPhaseIdSchema = z.string().min(1);
export type WorkflowPhaseId = z.infer<typeof WorkflowPhaseIdSchema>;

export const WorkflowRunStatusSchema = z.enum([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;

export const WorkflowNodeStatusSchema = z.enum([
  "pending",
  "active",
  "completed",
  "failed",
  "skipped",
  "cancelled",
]);
export type WorkflowNodeStatus = z.infer<typeof WorkflowNodeStatusSchema>;

export const WorkflowGraphCollectionStatusSchema = z.enum(["active", "draining", "exhausted"]);
export type WorkflowGraphCollectionStatus = z.infer<typeof WorkflowGraphCollectionStatusSchema>;

export const ExpertWorkflowPhaseSchema = z.enum([
  "clarify",
  "task_analysis",
  "arch_decompose",
  "env_setup",
  "meta_prompt",
  "exec",
  "final_critic",
  "complete",
]);
export type ExpertWorkflowPhase = z.infer<typeof ExpertWorkflowPhaseSchema>;

export const WorkflowStrategySchema = z.object({
  clarify: z.object({
    confidenceThreshold: z.number(),
    maxRounds: z.number().int().positive(),
    minRounds: z.number().int().nonnegative(),
  }),
  executor: z.object({
    drainingChangeHours: z.number().positive(),
    frontierTarget: z.number().int().positive(),
    maxConcurrentLoops: z.number().int().positive(),
    maxConsecutiveErrors: z.number().int().positive(),
    maxPlannerRuns: z.number().int().positive(),
  }),
  finalCritic: z.object({
    maxIterations: z.number().int().positive(),
  }),
  reactLoop: z.object({
    maxRounds: z.number().int().positive(),
  }),
});
export type WorkflowStrategy = z.infer<typeof WorkflowStrategySchema>;

export const WorkflowPhaseBehaviorSchema = z.enum([
  "agent",
  "scheduled_graph",
  "critic",
  "complete",
]);
export type WorkflowPhaseBehavior = z.infer<typeof WorkflowPhaseBehaviorSchema>;

export const WorkflowGraphSeedSourceSchema = z.object({
  gateAfterPhase: WorkflowPhaseIdSchema.optional(),
  targetPhase: WorkflowPhaseIdSchema,
});
export type WorkflowGraphSeedSource = z.infer<typeof WorkflowGraphSeedSourceSchema>;

export const WorkflowPhaseDefinitionSchema = z.object({
  artifactPath: z.string().optional(),
  behavior: WorkflowPhaseBehaviorSchema.default("agent"),
  description: z.string().min(1),
  nodePromptsFromArtifact: z
    .object({
      targetPhase: WorkflowPhaseIdSchema,
    })
    .optional(),
  phase: WorkflowPhaseIdSchema,
  seedGraphFromArtifact: WorkflowGraphSeedSourceSchema.optional(),
  title: z.string().min(1),
});
export type WorkflowPhaseDefinition = z.infer<typeof WorkflowPhaseDefinitionSchema>;

export const WorkflowDefinitionSchema = z
  .object({
    definitionId: z.string().min(1),
    definitionVersion: z.string().min(1),
    description: z.string().optional(),
    kind: WorkflowKindSchema,
    phaseOrder: z.array(WorkflowPhaseIdSchema).min(1),
    phases: z.array(WorkflowPhaseDefinitionSchema).min(1),
    strategy: WorkflowStrategySchema,
    title: z.string().min(1),
  })
  .superRefine((definition, context) => {
    const seenPhases = new Set<string>();
    for (const phase of definition.phases) {
      if (seenPhases.has(phase.phase)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate workflow phase definition: ${phase.phase}`,
          path: ["phases"],
        });
      }
      seenPhases.add(phase.phase);
    }

    const seenOrder = new Set<string>();
    for (const phase of definition.phaseOrder) {
      if (seenOrder.has(phase)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate workflow phase order entry: ${phase}`,
          path: ["phaseOrder"],
        });
      }
      seenOrder.add(phase);
      if (!seenPhases.has(phase)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Workflow phaseOrder references unknown phase: ${phase}`,
          path: ["phaseOrder"],
        });
      }
    }

    for (const phase of seenPhases) {
      if (!seenOrder.has(phase)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Workflow phase definition is missing from phaseOrder: ${phase}`,
          path: ["phases"],
        });
      }
    }
  });
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const WorkflowArtifactSchema = z.object({
  contentType: z.string(),
  createdAt: z.string(),
  label: z.string(),
  path: z.string(),
  phase: WorkflowPhaseIdSchema.optional(),
});
export type WorkflowArtifact = z.infer<typeof WorkflowArtifactSchema>;

export const WorkflowPhaseSnapshotSchema = z.object({
  artifactPath: z.string().optional(),
  activityId: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  phase: WorkflowPhaseIdSchema,
  sessionId: z.string().optional(),
  startedAt: z.string().optional(),
  status: WorkflowNodeStatusSchema,
  traceId: z.string().optional(),
  turnId: z.string().optional(),
});
export type WorkflowPhaseSnapshot = z.infer<typeof WorkflowPhaseSnapshotSchema>;

export const WorkflowActivityKindSchema = z.enum([
  "agent_session",
  "planner_agent",
  "subplanner_agent",
  "actor_agent",
  "critic_agent",
]);
export type WorkflowActivityKind = z.infer<typeof WorkflowActivityKindSchema>;

export const WorkflowSessionLinkStatusSchema = z.enum([
  "starting",
  "running",
  "retrying_model",
  "waiting_permission",
  "completed",
  "failed",
  "cancelled",
]);
export type WorkflowSessionLinkStatus = z.infer<typeof WorkflowSessionLinkStatusSchema>;

export const WorkflowFailureKindSchema = z.enum([
  "network",
  "rate_limit",
  "timeout",
  "auth",
  "provider",
  "model_context",
  "configuration",
  "permission",
  "tool",
  "cancelled",
  "unknown",
]);
export type WorkflowFailureKind = z.infer<typeof WorkflowFailureKindSchema>;

export const WorkflowFailureSchema = z.object({
  activityId: z.string().optional(),
  code: z.string().optional(),
  kind: WorkflowFailureKindSchema,
  message: z.string(),
  nodeId: z.string().optional(),
  phase: WorkflowPhaseIdSchema.optional(),
  recoverable: z.boolean(),
  retryable: z.boolean(),
  sessionId: z.string().optional(),
  traceId: z.string().optional(),
  turnId: z.string().optional(),
});
export type WorkflowFailure = z.infer<typeof WorkflowFailureSchema>;

export const WorkflowRecoveryActionSchema = z.object({
  action: z.enum(["retry", "retry_with_current_model", "skip_node", "cancel"]),
  activityId: z.string().optional(),
  destructive: z.boolean().optional(),
  label: z.string(),
  nodeId: z.string().optional(),
  phase: WorkflowPhaseIdSchema.optional(),
});
export type WorkflowRecoveryAction = z.infer<typeof WorkflowRecoveryActionSchema>;

export const WorkflowSessionLinkSchema = z.object({
  activityId: z.string(),
  attempt: z.number().int().positive(),
  completedAt: z.string().optional(),
  kind: WorkflowActivityKindSchema,
  model: z.string().optional(),
  nodeId: z.string().optional(),
  parentSessionId: z.string().optional(),
  phase: WorkflowPhaseIdSchema,
  runId: z.string(),
  sessionId: z.string().optional(),
  startedAt: z.string(),
  status: WorkflowSessionLinkStatusSchema,
  traceId: z.string().optional(),
  turnId: z.string().optional(),
});
export type WorkflowSessionLink = z.infer<typeof WorkflowSessionLinkSchema>;
