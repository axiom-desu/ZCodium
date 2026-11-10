import {
  readProtocolIdentity,
  zcodeProtocolMethods,
  zcodeRuntimeCapabilitiesSchema,
} from "@zcode/shared";
import { ZCodeProtocolResponseError } from "./protocolResponseValidation.js";
import {
  ZCodeProtocolRequestTimeoutError,
  type ZCodeProtocolClient,
} from "./zcodeProtocolClient.js";

const PROBE_TIMEOUT_MS = 10_000;

export type AgentProtocolProbeResult =
  | { status: "verified" | "unverified" }
  | { status: "incompatible" | "invalid"; error: ZCodeProtocolResponseError };

/** 一次只读观测，无缓存、重试或业务状态；身份比较与 schema 校验仍由 protocol client 唯一负责。 */
export async function probeAgentProtocol(
  client: Pick<ZCodeProtocolClient, "request" | "isDisposed" | "storageStartup">,
): Promise<AgentProtocolProbeResult> {
  try {
    const capabilities = await client.request(
      zcodeProtocolMethods.runtimeCapabilities,
      {},
      zcodeRuntimeCapabilitiesSchema,
      {
        lifecycle: "observation",
        timeoutMs: PROBE_TIMEOUT_MS,
        // Bug 修复：请求自身的计时器在 storage gate 后才创建；信号把启动等待也纳入同一预算。
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      },
    );
    return { status: readProtocolIdentity(capabilities) ? "verified" : "unverified" };
  } catch (error) {
    if (error instanceof ZCodeProtocolResponseError) {
      return {
        status: error.reasonCode === "agent_protocol_mismatch" ? "incompatible" : "invalid",
        error,
      };
    }
    // Bug 修复：终态失败/连接已关闭不能伪装成可用；只有明确的“不支持/观测超时”可恢复。
    if (client.isDisposed || client.storageStartup.snapshot?.phase === "failed") throw error;
    if (
      error instanceof ZCodeProtocolRequestTimeoutError ||
      (error instanceof DOMException && error.name === "TimeoutError") ||
      (error instanceof Error && "code" in error && error.code === -32601)
    )
      return { status: "unverified" };
    throw error;
  }
}
