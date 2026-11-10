import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  ChannelClient,
  ChannelServer,
  Emitter,
  SocketProtocol,
  VSBuffer,
  type IMessagePassingProtocol,
  type ISocket,
} from "@zcode/rpc";
import { createWebClientEndpoint, type WebClientRpcAttachment } from "./webClientEndpoint.js";

const roots: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** 内存字节管道：一端给真实 ChannelServer，另一端作为 endpoint 的 attachment。 */
function createProtocolPair() {
  const hostOut = new Emitter<VSBuffer>();
  const browserOut = new Emitter<VSBuffer>();
  const host = {
    onMessage: hostOut.event,
    send: (buffer: VSBuffer) => browserOut.fire(buffer),
  };
  const browser = {
    onMessage: browserOut.event,
    send: (buffer: VSBuffer) => hostOut.fire(buffer),
  };
  return {
    host,
    browser,
    dispose() {
      hostOut.dispose();
      browserOut.dispose();
    },
  };
}

/** 客户端侧 ISocket：一条 WS 帧就是一条协议消息（与浏览器端一致）。 */
function createClientSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buffer = Buffer.isBuffer(raw)
      ? raw
      : Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buffer)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === WebSocket.OPEN) ws.send(buffer.buffer);
    },
    end() {
      ws.close();
    },
    async drain() {},
    dispose() {
      onData.dispose();
      onClose.dispose();
      onEnd.dispose();
      ws.close();
    },
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-web-client-"));
  roots.push(root);
  await writeFile(join(root, "index.html"), "<!doctype html><title>web client</title>");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "assets/app.js"), "console.log('app');");
  // 静态根外的机密文件：任何路径写法都不能读到它。
  await writeFile(join(tmpdir(), "zcode-web-client-secret.txt"), "top-secret");

  const pair = createProtocolPair();
  cleanups.push(() => pair.dispose());

  let attachmentDisposed = false;
  let attachment: WebClientRpcAttachment;
  const endpoint = createWebClientEndpoint({
    logger: silentLogger,
    appVersion: "3.17.2-test",
    serverId: "test-server",
    staticRoot: root,
    bindAddresses: ["127.0.0.1"],
    authorizePairing: ({ deviceSid, passHash }) =>
      deviceSid === "device-1" && passHash === "hash-1",
    openAttachment: () => {
      // 同进程用例：endpoint 先订阅，再通过 start() 让对端 ChannelServer 发 Initialize。
      let server: ChannelServer<string> | undefined;
      attachment = {
        onMessage: pair.browser.onMessage,
        send: pair.browser.send,
        start() {
          server ??= new ChannelServer(pair.host as unknown as IMessagePassingProtocol, "host");
          server.registerChannel("probe", {
            call: async <T>(_ctx: string, command: string) => ({ command }) as T,
            listen: () => Emitter.None as never,
          });
        },
        dispose() {
          attachmentDisposed = true;
          server?.dispose();
          server = undefined;
        },
      };
      return attachment;
    },
  });
  cleanups.push(() => endpoint.stop());
  const info = await endpoint.start();
  return {
    baseUrl: info.baseUrls[0]!,
    port: info.port,
    attachmentDisposed: () => attachmentDisposed,
    root,
  };
}

async function pair(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}?sid=device-1&hash=hash-1&t=${Date.now()}`, {
    redirect: "manual",
  });
  expect(response.status).toBe(302);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  return setCookie!.split(";")[0]!;
}

/**
 * 建立 WS 并**立即返回**：必须在 `open` 之前挂好 message 监听，否则服务端首帧
 * （Host 的 Initialize）会在监听注册前到达并被丢弃。
 */
function connectSocket(port: number, cookie?: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: cookie ? { cookie } : undefined,
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    ws.once("open", () => resolvePromise());
    ws.once("unexpected-response", (_request, response) =>
      rejectPromise(new Error(`unexpected status ${response.statusCode}`)),
    );
    ws.once("error", rejectPromise);
  });
}

describe("web client endpoint", () => {
  it("serves the web bundle only after pairing, and rejects unauthenticated access", async () => {
    const fixture = await createFixture();
    const unauthorized = await fetch(`${fixture.baseUrl}`);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.text()).toContain("扫码");

    const cookie = await pair(fixture.baseUrl);
    const page = await fetch(`${fixture.baseUrl}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("web client");

    const asset = await fetch(`${fixture.baseUrl}assets/app.js`, { headers: { cookie } });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
  });

  it("rejects an invalid pairing link without issuing a cookie", async () => {
    const fixture = await createFixture();
    const response = await fetch(`${fixture.baseUrl}?sid=device-1&hash=wrong&t=${Date.now()}`, {
      redirect: "manual",
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("never serves files outside the static root", async () => {
    const fixture = await createFixture();
    const cookie = await pair(fixture.baseUrl);
    for (const path of ["/../zcode-web-client-secret.txt", "/..%2Fzcode-web-client-secret.txt"]) {
      const response = await fetch(`${fixture.baseUrl.replace(/\/$/u, "")}${path}`, {
        headers: { cookie },
      });
      expect(response.status, path).not.toBe(200);
    }
  });

  it("bridges an authenticated websocket to a real Host channel", async () => {
    const fixture = await createFixture();
    const cookie = await pair(fixture.baseUrl);
    const ws = connectSocket(fixture.port, cookie);
    const socket = createClientSocket(ws);
    const client = new ChannelClient(new SocketProtocol(socket));
    await waitForOpen(ws);
    const result = await client
      .getChannel<{ call<T>(name: string): Promise<T> }>("probe")
      .call("ping");
    expect(result).toEqual({ command: "ping" });
    client.dispose();
    ws.close();
  });

  it("refuses websocket upgrades without a cookie", async () => {
    const fixture = await createFixture();
    await expect(waitForOpen(connectSocket(fixture.port))).rejects.toThrow(
      /unexpected status 401/u,
    );
  });

  it("releases the Host attachment when the socket closes", async () => {
    const fixture = await createFixture();
    const cookie = await pair(fixture.baseUrl);
    const ws = connectSocket(fixture.port, cookie);
    const socket = createClientSocket(ws);
    const client = new ChannelClient(new SocketProtocol(socket));
    await waitForOpen(ws);
    await client.getChannel<{ call<T>(name: string): Promise<T> }>("probe").call("ping");
    client.dispose();
    ws.close();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    expect(fixture.attachmentDisposed()).toBe(true);
  });
});
