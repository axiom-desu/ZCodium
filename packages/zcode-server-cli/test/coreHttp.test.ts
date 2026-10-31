import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ServiceCollection } from "@zcode/services";
import {
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  serverRemoteAnonymousInfoSchema,
  serverRemoteInfoSchema,
} from "@zcode/shared";
import { createCoreHttpServer } from "../src/server-core/http.js";

const TOKEN = "test-ingress-token-0123456789";
const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function startServer(ingressToken?: string) {
  const server = await createCoreHttpServer(new ServiceCollection(), { ingressToken });
  servers.push(server);
  return {
    base: `http://${server.host}:${server.port}`,
    wsBase: `ws://${server.host}:${server.port}`,
  };
}

function authorizationHeaders(token = TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function expectWebSocketOpens(url: string, headers: Record<string, string> = {}) {
  const socket = new WebSocket(url, { headers });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      socket.close();
      resolve();
    });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      reject(new Error(`unexpected ${response.statusCode}`));
    });
    socket.once("error", reject);
  });
}

async function expectWebSocketRejected(
  url: string,
  headers: Record<string, string> = {},
): Promise<number | undefined> {
  const socket = new WebSocket(url, { headers });
  return await new Promise<number | undefined>((resolve, reject) => {
    socket.once("open", () => {
      socket.close();
      reject(new Error("WebSocket unexpectedly opened"));
    });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once("error", reject);
  });
}

describe("Core HTTP/WS ingress authentication", () => {
  it("serves authenticated server info with optional compatibility and identity", async () => {
    const { base } = await startServer(TOKEN);
    const response = await fetch(`${base}/api/server-info`, {
      headers: authorizationHeaders(),
    });
    expect(response.status).toBe(200);
    const info = serverRemoteInfoSchema.parse(await response.json());
    expect(info.authRequired).toBe(true);
    expect(info.compatibility?.schemaVersion).toBe(1);
    expect(info.identity?.hostname).toBeTruthy();
    // 本仓尚未注册 ProjectService/RPC，不得声明 virtualProjects。
    expect(info.capabilities.virtualProjects).toBeUndefined();
  });

  it("returns only a safe anonymous descriptor without a token", async () => {
    const { base } = await startServer(TOKEN);
    const response = await fetch(`${base}/api/server-info`);
    expect(response.status).toBe(200);
    const body = await response.json();
    const anonymous = serverRemoteAnonymousInfoSchema.parse(body);
    expect(anonymous.authRequired).toBe(true);
    expect(body).not.toHaveProperty("serverId");
    expect(body).not.toHaveProperty("workspaces");
    expect(body).not.toHaveProperty("identity");
    const capability = await fetch(`${base}/api/rpc-host-capability`, { method: "POST" });
    expect(capability.status).toBe(401);
  });

  it("requires the bearer token on both replayable and continuous WebSocket endpoints", async () => {
    const { base, wsBase } = await startServer(TOKEN);
    expect(await expectWebSocketRejected(`${wsBase}/ws`)).toBe(401);
    await expectWebSocketOpens(`${wsBase}/ws`, authorizationHeaders());

    expect(await expectWebSocketRejected(`${wsBase}/ws/host`, authorizationHeaders())).toBe(401);
    const capabilityResponse = await fetch(`${base}/api/rpc-host-capability`, {
      method: "POST",
      headers: authorizationHeaders(),
    });
    expect(capabilityResponse.status).toBe(200);
    const { capability } = (await capabilityResponse.json()) as { capability: string };
    await expectWebSocketOpens(`${wsBase}/ws/host`, {
      ...authorizationHeaders(),
      [ZCODE_RPC_HOST_CAPABILITY_HEADER]: capability,
    });
  });

  it("keeps loopback without a token unauthenticated for local development", async () => {
    const { base, wsBase } = await startServer();
    const response = await fetch(`${base}/api/server-info`);
    expect(response.status).toBe(200);
    expect((await response.json()).authRequired).toBe(false);
    await expectWebSocketOpens(`${wsBase}/ws`);
  });
});
