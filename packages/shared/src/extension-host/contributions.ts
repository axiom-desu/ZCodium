import { z } from "zod";

/**
 * 扩展贡献（slots）：扩展进程只能提交纯数据，Renderer 只渲染宿主内置组件。
 * 不接受 HTML / SVG / URL / 任意样式，避免扩展变成脚本注入面。
 */
export const EXTENSION_SLOT_IDS = ["navigation.primary", "status.composer"] as const;
export const extensionSlotIdSchema = z.enum(EXTENSION_SLOT_IDS);
export type ExtensionSlotId = z.infer<typeof extensionSlotIdSchema>;

/** 固定图标名；渲染端映射到内置图标组件，未知值在校验阶段被拒绝。 */
export const EXTENSION_SLOT_ICONS = ["puzzle", "list", "spark"] as const;
export const extensionSlotIconSchema = z.enum(EXTENSION_SLOT_ICONS);
export type ExtensionSlotIcon = z.infer<typeof extensionSlotIconSchema>;

export const EXTENSION_MAX_SLOTS_PER_PLUGIN = 16;
export const EXTENSION_MAX_SLOT_TITLE_LENGTH = 80;

export const extensionSlotContributionSchema = z.strictObject({
  /** 插件内唯一 id；用于 UI 去重与点击后的只读展示。 */
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
  slot: extensionSlotIdSchema,
  title: z.string().min(1).max(EXTENSION_MAX_SLOT_TITLE_LENGTH),
  icon: extensionSlotIconSchema.optional(),
  /** 同槽位排序；数值小的在前，相同按插件 id 与贡献 id 稳定排序。 */
  order: z.number().int().min(-1000).max(1000).optional(),
});
export type ExtensionSlotContribution = z.infer<typeof extensionSlotContributionSchema>;

export const extensionContributionsSchema = z.strictObject({
  slots: z.array(extensionSlotContributionSchema).max(EXTENSION_MAX_SLOTS_PER_PLUGIN),
});
export type ExtensionContributions = z.infer<typeof extensionContributionsSchema>;

/** 投影到 UI 的一条槽位（宿主补上插件身份与代际）。 */
export const extensionSlotProjectionSchema = extensionSlotContributionSchema.extend({
  pluginId: z.string().min(1).max(128),
  pluginName: z.string().min(1).max(200),
  generation: z.number().int().nonnegative(),
});
export type ExtensionSlotProjection = z.infer<typeof extensionSlotProjectionSchema>;

export function sortSlotProjections(
  slots: readonly ExtensionSlotProjection[],
): ExtensionSlotProjection[] {
  return [...slots].sort(
    (a, b) =>
      (a.order ?? 0) - (b.order ?? 0) ||
      a.pluginId.localeCompare(b.pluginId) ||
      a.id.localeCompare(b.id),
  );
}
