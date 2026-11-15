import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";

const nonEmptyString = z.string().trim().min(1);

export const providerProvisioningTriggerSchema = z.enum([
  "environment-online",
  "personal-config",
  "configured-default",
  // 数据同步页「模型提供商」分类在最近一次失败后由用户触发的重试；只有 Main 协调器发出。
  "user-retry",
]);
export type ProviderProvisioningTrigger = z.infer<typeof providerProvisioningTriggerSchema>;

/** Personal Config 的 Envelope；具体字段由 @zcode/provider 在目标 Environment 再校验。 */
export const providerProvisioningPersonalConfigSchema = z
  .object({
    providerConfigRules: z.object({ providerRules: z.array(z.unknown()) }).strict(),
    modelConfigRules: z
      .object({
        providerModelRules: z.array(z.unknown()),
        manualProviderModelRules: z.array(z.unknown()),
      })
      .strict(),
    providerOrder: z.array(nonEmptyString).optional(),
    defaultModelSelection: modelSelectionSchema.optional(),
  })
  .strict();

export type ProviderProvisioningPersonalConfig = z.infer<
  typeof providerProvisioningPersonalConfigSchema
>;

export const providerProvisioningEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(2),
    syncId: nonEmptyString,
    personalConfig: providerProvisioningPersonalConfigSchema,
  })
  .strict();

export type ProviderProvisioningEnvelope = z.infer<typeof providerProvisioningEnvelopeSchema>;

export const providerProvisioningResultSchema = z
  .object({
    syncId: nonEmptyString,
    status: z.enum(["applied", "already-applied", "unsupported", "failed", "rollback_failed"]),
    personalProviderCount: z.number().int().nonnegative(),
    configRevision: nonEmptyString.optional(),
    errorMessage: z.string().optional(),
    rolledBack: z.boolean(),
  })
  .strict();

export type ProviderProvisioningResult = z.infer<typeof providerProvisioningResultSchema>;

/** 跨进程只透传固定阶段码，不能把远端自由文本作为可公开诊断信息。 */
export const providerProvisioningErrorCodeSchema = z.enum([
  "source-read-failed",
  "target-call-failed",
  "target-write-failed",
  "target-refresh-failed",
  "target-commit-failed",
  "target-apply-failed",
  "capability-unavailable",
  "session-unavailable",
  "host-execution-failed",
]);
export type ProviderProvisioningErrorCode = z.infer<typeof providerProvisioningErrorCodeSchema>;

/** Host 保存本地 Source 后通知 Main 的触发源；首次上线与用户重试只由 Main 协调器自己产生。 */
export type ProviderProvisioningSourceTrigger = Exclude<
  ProviderProvisioningTrigger,
  "environment-online" | "user-retry"
>;

/**
 * Main 协调器按 lane（Environment key）在内存中保留的最近一次执行结果，按 sourceServerId 查询。
 * 只在本机 Main → Host → Renderer 之间流转，不持久化，不进入远程 workspace RPC 合同与手机白名单。
 * - `none`：该设备没有已注册的 lane（本机没有打开该设备上的项目），不下发也不能重试。
 * - `present`：有 lane；`running` 为当前是否有 drain 在执行；`lastResult` 只含时间、结果与固定阶段码，不含 Secret。
 */
export const providerProvisioningLaneStatusSchema = z.discriminatedUnion("lane", [
  z.object({ lane: z.literal("none") }).strict(),
  z
    .object({
      lane: z.literal("present"),
      running: z.boolean(),
      lastResult: z
        .object({
          at: z.number().int().nonnegative(),
          outcome: z.enum(["success", "failed"]),
          errorCode: providerProvisioningErrorCodeSchema.optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);
export type ProviderProvisioningLaneStatus = z.infer<typeof providerProvisioningLaneStatusSchema>;
