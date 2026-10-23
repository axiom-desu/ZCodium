// 权限规则求值：纯字符串/规则匹配，不持有规则集（规则集由 PermissionService 唯一持有）。

import {
  PermissionCapabilityGroup,
  type PermissionRuleValue,
  type PermissionRuleset,
} from "@zcode/contracts";
import { OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME } from "@zcode/shared";
import { webFetchRuleSubjects, wildcardToRegExp } from "./rule-matching.js";
import { isWebFetchPreapprovedUrl } from "../tool/webfetch-preapproved.js";
import type { ToolPermissionRulePolicy } from "../tool/types.js";
import type { PermissionBehavior, PermissionContext } from "./service.js";
import type { ResolvedPermissionCapability } from "./capability-resolution.js";

export function matchesProjectRules(
  ruleset: PermissionRuleset | null | undefined,
  behavior: PermissionBehavior,
  context: PermissionContext,
  capability: ResolvedPermissionCapability,
  rulePolicy?: ToolPermissionRulePolicy,
): boolean {
  const rules = ruleset?.[behavior];
  if (!Array.isArray(rules)) return false;
  const toolRules = rules.filter((rule) => matchesRuleScope(rule, context.toolName, capability));
  if (toolRules.length === 0) return false;
  if (rulePolicy) return rulePolicy.evaluateRules(behavior, toolRules);
  return toolRules.some((rule) => matchesRule(rule, context, capability));
}

export function matchesRule(
  rule: PermissionRuleValue,
  context: PermissionContext,
  capability: ResolvedPermissionCapability,
): boolean {
  if (!matchesRuleScope(rule, context.toolName, capability)) return false;
  if (!rule.ruleContent) return true;

  const subjects = ruleSubjects(context.input, context.toolName);
  if (subjects.length === 0) return false;

  return subjects.some((subject) => matchesRuleContent(subject, rule.ruleContent!));
}

function matchesRuleToolName(ruleToolName: string, contextToolName: string): boolean {
  if (ruleToolName === contextToolName) return true;
  return contextToolName === "Write" && ruleToolName === "Edit";
}

export function matchesRuleScope(
  rule: PermissionRuleValue,
  contextToolName: string,
  capability: ResolvedPermissionCapability,
): boolean {
  if (rule.toolName === OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME) {
    // 保留 key 只有在当前 tool entry 另行携带宿主验证后的 official_cua
    // capability 时才匹配。同名第三方 MCP、authority 漂移以及旧普通 tool
    // 都不能把可解析的 wire/storage 字符串升级成可信能力。
    return capability.permissionCapabilityGroup === PermissionCapabilityGroup.OfficialCua;
  }
  return matchesRuleToolName(rule.toolName, contextToolName);
}

function ruleSubjects(input: unknown, toolName: string): string[] {
  if (typeof input === "string") return [input];
  if (!input || typeof input !== "object") return [];

  const record = input as Record<string, unknown>;
  if (toolName === "WebFetch" && typeof record.url === "string") {
    return webFetchRuleSubjects(record.url);
  }

  for (const key of ["command", "url", "file_path", "path", "pattern", "patch_text"]) {
    const value = record[key];
    if (typeof value === "string") return [value];
  }

  return [];
}

export function isPreapprovedWebFetchRequest(context: PermissionContext): boolean {
  if (context.toolName !== "WebFetch") return false;
  if (!context.input || typeof context.input !== "object") return false;
  const url = (context.input as Record<string, unknown>).url;
  return typeof url === "string" && isWebFetchPreapprovedUrl(url);
}

export function matchesRuleContent(subject: string, ruleContent: string): boolean {
  if (ruleContent.endsWith(":*")) {
    const prefix = ruleContent.slice(0, -2);
    return (
      subject === prefix || subject.startsWith(`${prefix} `) || subject.startsWith(`${prefix}\t`)
    );
  }

  if (ruleContent.includes("*")) {
    return wildcardToRegExp(ruleContent).test(subject);
  }

  return subject === ruleContent;
}
