import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { controlResponseSchema, type ControlRequest } from "../contracts.js";
import { encodeJsonLine, JsonLineDecoder } from "./framing.js";
import { ControlRequestError } from "./controlError.js";

// Omit 不对 union 分发：直接 Omit<ControlRequest, "id"> 会丢掉 confirmation/force 等
// 变体字段，调用方无法以字面量构造合法请求。用分发式 Omit 保留每个命令的完整形状。
type DistributedOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ControlRequestInput = DistributedOmit<ControlRequest, "id">;

export async function requestControl(
  endpoint: string,
  request: ControlRequestInput,
  timeoutMs = 10_000,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const id = randomUUID();
  const socket = connect(endpoint);
  const decoder = new JsonLineDecoder();
  return await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const abort = () => fail(signal?.reason ?? new Error("Supervisor control request aborted"));
    const timeout = setTimeout(() => {
      fail(new Error("Supervisor control request timed out"));
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.on("error", fail);
    // 被复用的 Supervisor 可能在 readiness 期间退出，EOF 不能假装仍在等待 ready。
    socket.on("close", () => fail(new Error("Supervisor control connection closed")));
    socket.on("data", (chunk: string) => {
      try {
        const response = decoder.push(chunk)[0];
        if (response === undefined) return;
        const parsed = controlResponseSchema.parse(response);
        if (parsed.id !== id) return;
        cleanup();
        socket.end();
        if (parsed.ok) resolve(parsed.result);
        else
          reject(
            new ControlRequestError(
              parsed.error?.code ?? "request-failed",
              parsed.error?.message ?? "Supervisor request failed",
              parsed.error?.retryable,
            ),
          );
      } catch (error) {
        fail(error);
      }
    });
    socket.on("connect", () => socket.write(encodeJsonLine({ ...request, id })));
  });
}
