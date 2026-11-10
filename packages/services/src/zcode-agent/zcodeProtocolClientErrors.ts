import type { ZCodeProtocolMethod, ZCodeProtocolRequestId } from "@zcode/shared";
import type { V4Method } from "@zcode/shared/zcode-protocol-v4";

export class ZCodeProtocolClientError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "ZCodeProtocolClientError";
  }
}

export class ZCodeProtocolRequestTimeoutError extends Error {
  constructor(
    readonly method: ZCodeProtocolMethod | V4Method,
    readonly requestId: ZCodeProtocolRequestId,
    readonly timeoutMs: number,
  ) {
    super(`ZCode Protocol request timed out: ${method}`);
    this.name = "ZCodeProtocolRequestTimeoutError";
  }
}
