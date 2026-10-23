import type { ContextSectionSource, ContextUsageSource, TraceSpanLane } from "./shared";

export type DebugView = "trace" | "gantt";

export interface SourceInputs {
  projectId: string;
  logDir: string;
  eventPath: string;
  dbPath: string;
  sessionId: string;
}

export interface ObservationEventState {
  connected: boolean;
  error: string | null;
  lastChangeAt?: string;
  watchedPathCount: number;
}

export const emptyInputs: SourceInputs = {
  projectId: "",
  logDir: "",
  eventPath: "",
  dbPath: "",
  sessionId: "",
};

export const lastProjectStorageKey = "zcode-debug:last-project-id";

export const viewLabels: Record<DebugView, string> = {
  trace: "Trace",
  gantt: "甘特图",
};

export const laneOrder: TraceSpanLane[] = [
  "turn",
  "model",
  "tool",
  "permission",
  "subagent",
  "network",
  "storage",
  "log",
  "event",
];

export const laneLabels: Record<TraceSpanLane, string> = {
  turn: "Turn",
  model: "模型",
  tool: "工具",
  network: "网络",
  permission: "权限",
  storage: "存储",
  subagent: "子 Agent",
  event: "事件",
  log: "日志",
};

export const sourceLabels: Record<ContextSectionSource, string> = {
  system_prompt: "系统",
  skills: "技能",
  tools: "工具",
  other: "其他",
};

export const sourceClasses: Record<ContextSectionSource, string> = {
  system_prompt: "tone-system",
  skills: "tone-skills",
  tools: "tone-tools",
  other: "tone-other",
};

export const usageSourceLabels: Record<ContextUsageSource, string> = {
  system_prompt: "系统提示",
  meta_user_context: "Meta User 上下文",
  skills: "技能",
  tool_prompt: "工具提示",
  system_tool_schemas: "系统工具",
  mcp_tool_schemas: "MCP 工具",
  messages: "消息",
  other: "其他",
};

export const usageSourceClasses: Record<ContextUsageSource, string> = {
  system_prompt: "tone-system",
  meta_user_context: "tone-meta-user",
  skills: "tone-skills",
  tool_prompt: "tone-tools",
  system_tool_schemas: "tone-tool-schema",
  mcp_tool_schemas: "tone-mcp",
  messages: "tone-messages",
  other: "tone-other",
};
