import { Emitter } from "@zcode/rpc";
import {
  zcodeProtocolMethods,
  zcodeSessionMessagesResultSchema,
  type ZCodeProtocolMessage,
} from "@zcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeAgentProtocol } from "./protocolHandshake.js";
import { ZCodeProtocolClient } from "./zcodeProtocolClient.js";

const clients: ZCodeProtocolClient[] = [];
function connection(reply?: unknown, requireStorageStartup = false) {
  const received = new Emitter<ZCodeProtocolMessage>();
  const closed = new Emitter<{ reason?: string }>();
  const sent = vi.fn(async (message: ZCodeProtocolMessage) => {
    if (reply !== undefined && "id" in message) {
      received.fire({ id: message.id, result: reply });
    }
  });
  const client = new ZCodeProtocolClient(
    {
      kind: "memory",
      onMessage: received.event,
      onClose: closed.event,
      send: sent,
      dispose() {
        received.dispose();
        closed.dispose();
      },
    },
    { requireStorageStartup },
  );
  clients.push(client);
  return { client, received, sent };
}
afterEach(() => {
  clients.splice(0).forEach((client) => client.dispose());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const protocol = { name: "ZCode Protocol", version: 1 };
describe("runtime/capabilities handshake over the real protocol client", () => {
  it("verifies a declared compatible identity without listing sessions", async () => {
    const { client, sent } = connection({ protocol, independentPlanState: true });
    expect(await probeAgentProtocol(client)).toEqual({ status: "verified" });
    expect(sent).toHaveBeenCalledOnce();
    expect(sent.mock.calls[0]?.[0]).toMatchObject({ method: "runtime/capabilities", params: {} });
  });
  it.each([
    { name: protocol.name, version: 3 },
    { name: "Other Protocol", version: 1 },
  ])(
    "rejects a different identity even though capabilities schema accepts it: %j",
    async (actual) => {
      const { client } = connection({ protocol: actual, independentPlanState: true });
      const result = await probeAgentProtocol(client);
      expect(result.status).toBe("incompatible");
      if (result.status !== "incompatible") throw new Error("expected mismatch");
      expect(result.error.reasonCode).toBe("agent_protocol_mismatch");
      expect(result.error.details.actual).toEqual(actual);
      expect(result.error.message).toContain(`v${actual.version}`);
      expect(result.error.message).toContain("v1");
    },
  );
  it("keeps old agents without a declaration explicitly unverified", async () => {
    const { client } = connection({ independentPlanState: true });
    expect(await probeAgentProtocol(client)).toEqual({ status: "unverified" });
  });
  it("does not label malformed responses as a proven version mismatch", async () => {
    const { client } = connection({ independentPlanState: "wrong" });
    const result = await probeAgentProtocol(client);
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") throw new Error("expected invalid response");
    expect(result.error.reasonCode).toBe("agent_response_invalid");
    expect(result.error.message).toContain("未声明协议版本");
    expect(result.error.message).not.toContain("版本不匹配");
  });
  it("keeps unsupported methods recoverable", async () => {
    const { client, received, sent } = connection();
    const pending = probeAgentProtocol(client);
    const request = sent.mock.calls[0]?.[0];
    if (!request || !("id" in request)) throw new Error("expected request");
    received.fire({ id: request.id, error: { code: -32601, message: "Method not found" } });
    expect(await pending).toEqual({ status: "unverified" });
  });
  it.each([false, true])(
    "has a total 10s observation budget (storage gate = %s), never recycles the agent",
    async (storage) => {
      vi.useFakeTimers();
      // AbortSignal.timeout uses Node's native clock; mock its signal to exercise the total budget deterministically.
      const abort = new AbortController();
      const signal = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        setTimeout(() => abort.abort(new DOMException("Timed out", "TimeoutError")), ms);
        return abort.signal;
      });
      const { client, sent } = connection(undefined, storage);
      const recycle = vi.fn();
      client.onRequestTimeout(recycle);
      const pending = probeAgentProtocol(client);
      expect(client.pendingOperationRequestCount).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toEqual({ status: "unverified" });
      expect(recycle).not.toHaveBeenCalled();
      expect(client.isDisposed).toBe(false);
      expect(client.pendingRequestCount).toBe(0);
      expect(sent).toHaveBeenCalledTimes(storage ? 0 : 1);
      signal.mockRestore();
    },
  );
  it("cancels a stalled send without waiting for transport write completion", async () => {
    vi.useFakeTimers();
    const { client, sent } = connection();
    sent.mockImplementation(() => new Promise<void>(() => {}));
    const recycle = vi.fn();
    client.onRequestTimeout(recycle);
    const pending = probeAgentProtocol(client);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ status: "unverified" });
    expect(client.pendingRequestCount).toBe(0);
    expect(recycle).not.toHaveBeenCalled();
  });
  it("does not swallow send failures or claim a disposed client is available", async () => {
    const { client, sent } = connection();
    sent.mockRejectedValue(new Error("send failed"));
    await expect(probeAgentProtocol(client)).rejects.toThrow("send failed");
    expect(client.pendingRequestCount).toBe(0);
    client.dispose();
    await expect(probeAgentProtocol(client)).rejects.toThrow("disposed");
  });
  it("bounds native AbortSignal cancellation while waiting for storage", async () => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(10));
    const { client, sent } = connection(undefined, true);
    expect(await probeAgentProtocol(client)).toEqual({ status: "unverified" });
    expect(sent).not.toHaveBeenCalled();
  });
  it("normalizes whitespace in declared names consistently with the schema", async () => {
    const { client } = connection({ protocol: { ...protocol, name: " ZCode Protocol " } });
    expect(await probeAgentProtocol(client)).toEqual({ status: "verified" });
  });
  it("formats real schema failures without exposing raw issues or peer values", async () => {
    const secret = "PRIVATE-SERVER-VALUE";
    const { client } = connection({ messages: [{ sessionID: secret, messageID: "m", id: "p" }] });
    const error = await client
      .request(zcodeProtocolMethods.sessionMessages, {}, zcodeSessionMessagesResultSchema)
      .catch((e) => e);
    expect(error.reasonCode).toBe("agent_response_invalid");
    expect(error.message).toContain("session/messages");
    expect(error.message).toContain("未声明协议版本");
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain('"code"');
    expect(error.message.length).toBeLessThanOrEqual(300);
    expect(error.cause).toHaveProperty("issues");
  });
});
