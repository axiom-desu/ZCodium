import { z } from "zod";

/**
 * 设备 ↔ 端点（LAN 直连服务 / 用户自托管 relay）的 wire 帧契约。
 * 与官方 3.14.3 恢复结果保持字段兼容；官方未公开项见 spec「开放问题」。
 */

const nonEmptyStringSchema = z.string().trim().min(1);

export const webRemoteControlTransportStateSchema = z.enum([
  "idle",
  "connecting",
  "registering",
  "authenticating",
  "waiting_terminal",
  "paired",
  "kicked",
  "error",
]);
export type WebRemoteControlTransportState = z.infer<typeof webRemoteControlTransportStateSchema>;

export const webRemoteControlPairStatusSchema = z.enum(["waiting", "matched"]);
export type WebRemoteControlPairStatus = z.infer<typeof webRemoteControlPairStatusSchema>;

export const webRemoteControlRelayErrorCodeSchema = z.enum([
  "KICKED",
  "AUTH_FAILED",
  "INTERNAL",
  "WRONG_PARAM",
]);
export type WebRemoteControlRelayErrorCode = z.infer<typeof webRemoteControlRelayErrorCodeSchema>;

export const webRemoteControlTransportMetaSchema = z
  .object({
    platform: z.string().optional(),
    version: z.string().optional(),
    name: z.string().optional(),
  })
  .strict();
export type WebRemoteControlTransportMeta = z.infer<typeof webRemoteControlTransportMetaSchema>;

const deviceRegisterInitFrameSchema = z
  .object({
    type: z.literal("device_register_init"),
    device_mid: nonEmptyStringSchema,
    pass_hash: nonEmptyStringSchema,
    meta: webRemoteControlTransportMetaSchema.optional(),
    client_ts: z.number().int().nonnegative(),
  })
  .strict();

const deviceRegisterAckFrameSchema = z
  .object({
    type: z.literal("device_register_ack"),
    device_sid: nonEmptyStringSchema,
  })
  .strict();

const authInitFrameSchema = z
  .object({
    type: z.literal("auth_init"),
    role: z.enum(["device", "mobile"]),
    device_sid: nonEmptyStringSchema,
    meta: webRemoteControlTransportMetaSchema.optional(),
    client_ts: z.number().int().nonnegative(),
  })
  .strict();

const authChallengeFrameSchema = z
  .object({
    type: z.literal("auth_challenge"),
    nonce: nonEmptyStringSchema,
  })
  .strict();

const authResponseFrameSchema = z
  .object({
    type: z.literal("auth_response"),
    device_sid: nonEmptyStringSchema,
    proof: nonEmptyStringSchema,
    client_ts: z.number().int().nonnegative(),
  })
  .strict();

const authAckFrameSchema = z
  .object({
    type: z.literal("auth_ack"),
    // 官方 auth_ack 与 pair_status_ack 同走 applyPairStatus，因此也带 pair_status。
    pair_status: z.enum(["waiting", "matched"]),
  })
  .strict();

const pairStatusQueryFrameSchema = z
  .object({
    type: z.literal("pair_status_query"),
    device_sid: nonEmptyStringSchema,
    client_ts: z.number().int().nonnegative(),
  })
  .strict();

const pairStatusAckFrameSchema = z
  .object({
    type: z.literal("pair_status_ack"),
    pair_status: z.enum(["waiting", "matched"]),
  })
  .strict();

const dataFrameSchema = z
  .object({
    type: z.literal("data"),
    payload: z.unknown(),
  })
  .strict();

const errorFrameSchema = z
  .object({
    type: z.literal("error"),
    code: z.enum(["KICKED", "AUTH_FAILED", "INTERNAL", "WRONG_PARAM"]),
    message: z.string().optional(),
  })
  .strict();

export const webRemoteControlRelayFrameSchema = z.discriminatedUnion("type", [
  deviceRegisterInitFrameSchema,
  deviceRegisterAckFrameSchema,
  authInitFrameSchema,
  authChallengeFrameSchema,
  authResponseFrameSchema,
  authAckFrameSchema,
  pairStatusQueryFrameSchema,
  pairStatusAckFrameSchema,
  dataFrameSchema,
  errorFrameSchema,
]);
export type WebRemoteControlRelayFrame = z.infer<typeof webRemoteControlRelayFrameSchema>;

/** 端点（LAN 服务 / relay）→ 移动端方向。 */
export const webRemoteControlEndpointToMobileFrameSchema = z.discriminatedUnion("type", [
  deviceRegisterAckFrameSchema,
  authChallengeFrameSchema,
  authAckFrameSchema,
  pairStatusAckFrameSchema,
  dataFrameSchema,
  errorFrameSchema,
]);
export type WebRemoteControlEndpointToMobileFrame = z.infer<
  typeof webRemoteControlEndpointToMobileFrameSchema
>;

/** 移动端 → 端点（LAN 服务 / relay）方向。 */
export const webRemoteControlMobileToEndpointFrameSchema = z.discriminatedUnion("type", [
  deviceRegisterInitFrameSchema,
  authInitFrameSchema,
  authResponseFrameSchema,
  pairStatusQueryFrameSchema,
  dataFrameSchema,
]);
export type WebRemoteControlMobileToEndpointFrame = z.infer<
  typeof webRemoteControlMobileToEndpointFrameSchema
>;
