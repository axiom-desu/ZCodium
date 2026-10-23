// 权限能力解析与决策结果投影：把 tool capability 归一到 ResolvedPermissionCapability，
// 并按原有 10 个字段构造 PermissionDecisionResult（字段集合与语义不得压缩）。

import type {
  ModelToolSideEffectScope,
  PermissionCapabilityGroup as PermissionCapabilityGroupType,
  RiskLevel,
} from "@zcode/contracts";
import type {
  PermissionBehavior,
  PermissionContext,
  PermissionDecisionResult,
  PermissionToolCapability,
} from "./service.js";

export interface ResolvedPermissionCapability {
  allowedInPlanMode: boolean;
  alwaysAsk: boolean;
  readOnly: boolean;
  destructive: boolean;
  requiresUserInteraction: boolean;
  sideEffectScope: ModelToolSideEffectScope;
  riskLevel: RiskLevel;
  needsApproval: boolean;
  permissionCapabilityGroup?: PermissionCapabilityGroupType;
  permissionName?: string;
}

function isReadOnlyTool(name: string): boolean {
  return new Set([
    "Read",
    "Glob",
    "Grep",
    "WebSearch",
    "WebFetch",
    "TodoRead",
    "TodoWrite",
    "AskUserQuestion",
    "Agent",
    "Task",
    "Skill",
  ]).has(name);
}

function isWriteTool(name: string): boolean {
  return new Set(["Write", "Edit", "ApplyPatch", "Bash"]).has(name);
}

function isDestructiveTool(name: string): boolean {
  return new Set(["Bash"]).has(name);
}

export function resolveRiskLevel(
  toolName: string,
  toolCapability?: PermissionToolCapability,
): RiskLevel {
  if (toolCapability?.riskLevel) {
    return toolCapability.riskLevel;
  }

  if (isReadOnlyTool(toolName)) {
    return "low";
  }

  if (isWriteTool(toolName)) {
    return "medium";
  }

  if (isDestructiveTool(toolName)) {
    return "high";
  }

  return "medium";
}

export function resolveCapabilityFor(
  context: PermissionContext,
  toolCapability?: PermissionToolCapability,
): ResolvedPermissionCapability {
  return {
    allowedInPlanMode: toolCapability?.allowedInPlanMode ?? false,
    alwaysAsk: toolCapability?.permission?.alwaysAsk ?? toolCapability?.alwaysAsk ?? false,
    readOnly: toolCapability?.readOnly ?? isReadOnlyTool(context.toolName),
    destructive: toolCapability?.destructive ?? isDestructiveTool(context.toolName),
    requiresUserInteraction:
      toolCapability?.requiresUserInteraction ??
      (toolCapability?.permission?.sideEffectScope ?? toolCapability?.sideEffectScope) ===
        "userInteraction",
    sideEffectScope:
      toolCapability?.permission?.sideEffectScope ??
      toolCapability?.sideEffectScope ??
      (isReadOnlyTool(context.toolName) ? "none" : "workspace"),
    riskLevel:
      toolCapability?.permission?.riskLevel ?? resolveRiskLevel(context.toolName, toolCapability),
    needsApproval:
      toolCapability?.permission?.needsApproval ??
      toolCapability?.needsApproval ??
      !isReadOnlyTool(context.toolName),
    permissionCapabilityGroup: toolCapability?.permissionCapabilityGroup,
    permissionName: toolCapability?.permission?.permission,
  };
}

export function allowDecision(
  context: PermissionContext,
  capability: ResolvedPermissionCapability,
  ruleId: string,
  reason?: string,
): PermissionDecisionResult {
  return createPermissionDecision("allow", context, capability, ruleId, reason);
}

export function askDecision(
  context: PermissionContext,
  capability: ResolvedPermissionCapability,
  ruleId: string,
  reason: string,
): PermissionDecisionResult {
  return createPermissionDecision("ask", context, capability, ruleId, reason);
}

export function denyDecision(
  context: PermissionContext,
  capability: ResolvedPermissionCapability,
  ruleId: string,
  reason: string,
): PermissionDecisionResult {
  return createPermissionDecision("deny", context, capability, ruleId, reason);
}

export function createPermissionDecision(
  decision: PermissionBehavior,
  context: PermissionContext,
  capability: ResolvedPermissionCapability,
  ruleId: string,
  reason?: string,
): PermissionDecisionResult {
  return {
    decision,
    allowed: decision === "allow",
    escalated: decision === "ask",
    mode: context.mode,
    reason,
    riskLevel: capability.riskLevel,
    ruleId,
    sideEffectScope: capability.sideEffectScope,
    ...(capability.alwaysAsk ? { alwaysAsk: true } : {}),
  };
}
