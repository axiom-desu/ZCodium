import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

// 插件发现工具（上游 3.18 F10）。模型可见的只有「按键词搜目录」与「请求安装/启用某个
// 官方插件」这两个意图；候选里的 pluginId 是唯一可信身份，其余字段都是展示用投影。
export const SEARCH_PLUGINS_TOOL_NAME = "SearchPlugins";
export const SUGGEST_PLUGIN_INSTALL_TOOL_NAME = "SuggestPluginInstall";
export const PLUGIN_DISCOVERY_PAGE_SIZE = 10;
const text = z.string().trim().min(1).max(2_000);
const localeText = z.record(z.string(), z.string());
export const PluginDiscoveryCandidateSchema = z
  .object({
    pluginId: text,
    name: text,
    displayName: z.string().optional(),
    displayNameI18n: localeText.optional(),
    description: z.string().optional(),
    descriptionI18n: localeText.optional(),
    icon: z.string().optional(),
    category: z.string().optional(),
    examplePrompts: z.array(z.string()).optional(),
    installed: z.boolean(),
    enabled: z.boolean(),
    // 目录侧给出「这一条需要什么动作」：装、启用、还是已经可用。
    action: z.enum(["install", "enable", "none"]),
    // 会话内的确认只授权当前 workspace；不含 user 级覆盖，避免跨 workspace 越权。
    scope: z.enum(["user", "workspace"]),
  })
  .strict();
export type PluginDiscoveryCandidate = z.infer<typeof PluginDiscoveryCandidateSchema>;
export const SearchPluginsInputSchema = z
  .object({
    query: text.describe(
      "Search keywords for the capability needed. Include service names or alternative Chinese/English keywords when useful.",
    ),
    cursor: z.string().max(2_000).optional(),
  })
  .strict();
export const SearchPluginsOutputSchema = z
  .object({
    plugins: z.array(PluginDiscoveryCandidateSchema).max(PLUGIN_DISCOVERY_PAGE_SIZE),
    cursor: z.string().optional(),
    // 目录刷新失败时仍给旧结果，但必须显式告知过期；不能把陈旧目录当新鲜事实。
    stale: z.boolean(),
  })
  .strict();
export const SuggestPluginInstallInputSchema = z
  .object({
    pluginId: text.describe("Exact stable plugin ID previously returned by SearchPlugins."),
    reason: text.describe(
      "One short sentence explaining how this plugin helps the current user task.",
    ),
    reconsider: z
      .boolean()
      .optional()
      .describe(
        "Only true after a NEW user message explicitly asks to reconsider a previously skipped plugin. Never set proactively.",
      ),
  })
  .strict();
export const PluginActivationStatusSchema = z.enum([
  "ready",
  "disabled",
  "needsConfiguration",
  "refreshRequired",
  "failed",
]);
export type PluginActivationStatus = z.infer<typeof PluginActivationStatusSchema>;
export const SuggestPluginInstallOutputSchema = z
  .object({
    pluginId: text,
    status: z.enum([
      "installed",
      "enabled",
      "alreadyAvailable",
      "skipped",
      "unavailable",
      "failed",
    ]),
    activation: PluginActivationStatusSchema.optional(),
    message: z.string(),
  })
  .strict();
export type SearchPluginsInput = z.infer<typeof SearchPluginsInputSchema>;
export type SearchPluginsOutput = z.infer<typeof SearchPluginsOutputSchema>;
export type SuggestPluginInstallInput = z.infer<typeof SuggestPluginInstallInputSchema>;
export type SuggestPluginInstallOutput = z.infer<typeof SuggestPluginInstallOutputSchema>;
export const SearchPluginsInputJsonSchema = toToolJsonSchema(SearchPluginsInputSchema);
export const SearchPluginsOutputJsonSchema = toToolJsonSchema(SearchPluginsOutputSchema);
export const SuggestPluginInstallInputJsonSchema = toToolJsonSchema(SuggestPluginInstallInputSchema);
export const SuggestPluginInstallOutputJsonSchema = toToolJsonSchema(
  SuggestPluginInstallOutputSchema,
);
