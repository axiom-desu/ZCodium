import { z } from "zod";
import { parsePluginStoreOrder, type PluginStoreOrder } from "./pluginStoreOrder.js";

/** 只允许显式接入的公开字段进入服务快照，不透传账户或 Provider 配置。 */
export interface ClientConfigSnapshot {
  pluginStoreOrder: PluginStoreOrder | null;
  /** 仅解析保留；当前本仓没有无账号配置端点，不接后台请求。 */
  zsrcUrl: string | null;
  uiPluginRecommendations: { pluginId: string; surfaceId: string }[];
}

const uiPluginRecommendationsSchema = z.array(
  z.object({
    pluginId: z.string().trim().min(1),
    surfaceId: z.string().trim().min(1),
  }),
);

const zsrcSchema = z.object({
  url: z
    .string()
    .trim()
    .url()
    .refine((value) => /^https?:\/\//i.test(value)),
});

export const clientConfigReadOptionsSchema = z.object({
  forceRefresh: z.boolean().optional(),
});
export type ClientConfigReadOptions = z.infer<typeof clientConfigReadOptionsSchema>;

const envelopeSchema = z.object({
  code: z.literal(0),
  data: z
    .object({
      configs: z
        .object({
          pluginStoreOrder: z.unknown().optional(),
          zsrc: z.unknown().optional(),
          uiPluginRecommendations: z.unknown().optional(),
        })
        .nullish(),
    })
    .nullish(),
});

/** 未知字段一律不透传；某个公开字段坏掉只影响该字段。 */
export function parseClientConfigSnapshot(payload: unknown): ClientConfigSnapshot {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Invalid public client config response");
  const configs = parsed.data.data?.configs;
  return {
    pluginStoreOrder: parsePluginStoreOrder(configs?.pluginStoreOrder),
    zsrcUrl: zsrcSchema.safeParse(configs?.zsrc).data?.url ?? null,
    uiPluginRecommendations:
      uiPluginRecommendationsSchema.safeParse(configs?.uiPluginRecommendations).data ?? [],
  };
}
