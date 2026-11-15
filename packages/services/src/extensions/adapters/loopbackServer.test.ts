import { describe, expect, it, vi } from "vitest";
import { createExtensionViewServer } from "./loopbackServer.js";

const TOKEN = "t".repeat(32);

function body(pluginId = "alpha") {
  return JSON.stringify({
    v: 1,
    generation: 1,
    workspaceIdentity: "local:/tmp/ws",
    pluginId,
    capabilityId: "settings.get",
  });
}

describe("extension loopback server", () => {
  it("rejects Origin requests and converts handler failures into a closed 500", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const gateway = {
      call: vi.fn(async () => {
        throw new Error("backend exploded");
      }),
      contribute: vi.fn(),
      cancelPlugin: vi.fn(),
      cancelAll: vi.fn(),
    };
    const server = await createExtensionViewServer({
      authenticate: (token) => (token === TOKEN ? "alpha" : null),
      gateway: gateway as never,
    });
    try {
      const originDenied = await fetch(`${server.url}/capability`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
          origin: "http://127.0.0.1:3000",
        },
        body: body(),
      });
      expect(originDenied.status).toBe(401);

      const failed = await fetch(`${server.url}/capability`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: body(),
      });
      expect(failed.status).toBe(500);
      expect(await failed.json()).toMatchObject({ ok: false, code: "backend-error" });

      // handler rejection 被吞掉后服务器仍能继续服务下一个请求。
      const spoof = await fetch(`${server.url}/capability`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: body("beta"),
      });
      expect(spoof.status).toBe(500);
      expect(gateway.call).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
