import { z } from "zod";

/**
 * App 侧工具搜索模式：auto 按每次请求的实际 Model 决定 Native/Local，local 固定 Local，
 * off 使用全量工具。CLI 四值参数与默认 Off 独立，不受这里影响。
 */
export const appToolSearchModeSchema = z.enum(["auto", "local", "off"]);
export type AppToolSearchMode = z.infer<typeof appToolSearchModeSchema>;

export const APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL = "settings:app-runtime-preferences";
export const ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV = "ZCODE_E2E_ASK_USER_QUESTION_CLOCK_SCALE";

export const appRuntimePreferencesChangedBroadcastPayloadSchema = z
  .object({
    askUserQuestionAutoResolutionEnabled: z.boolean(),
  })
  .strict();

export type AppRuntimePreferencesChangedBroadcastPayload = z.infer<
  typeof appRuntimePreferencesChangedBroadcastPayloadSchema
>;
