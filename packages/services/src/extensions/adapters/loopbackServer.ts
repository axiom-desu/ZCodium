import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
  EXTENSION_LOOPBACK_MAX_BODY_BYTES,
  EXTENSION_VIEW_SERVER_HOST,
  extensionCapabilityRequestSchema,
  extensionContributionRequestSchema,
} from "@zcode/shared/extension-host";
import type { CapabilityGateway, ExtensionTransportAuth } from "../app/gateway.js";

/**
 * 扩展进程 ↔ 窗口 Host 的 loopback 服务器。
 *
 * 只接受回环地址、Bearer token、POST /capability 与 /contribute。没有 Origin 头（浏览器/手机 Web
 * 页面一定带 Origin）不是可选项：带上就拒绝，避免扩展服务被 Web 页面复用。
 *
 * Bearer token 是唯一身份来源：`authenticate` 返回它绑定的 pluginId，body 里的 pluginId 只被校验，
 * 不能用来声称另一个插件。业务准入仍由能力网关按身份/代际/工作区/授权判定。
 */
export interface ExtensionViewServer {
  url: string;
  close(): Promise<void>;
}

export async function createExtensionViewServer(options: {
  authenticate(token: string): string | null;
  gateway: CapabilityGateway;
}): Promise<ExtensionViewServer> {
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    // handler 必须自己吞掉 rejection；否则挂起连接或客户端中断会变成 unhandledRejection。
    void handle(request, response, options).catch(() => failClosed(response));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, EXTENSION_VIEW_SERVER_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server, sockets);
    throw new Error("Extension view server did not bind to a TCP port.");
  }
  return {
    url: `http://${EXTENSION_VIEW_SERVER_HOST}:${address.port}`,
    close: () => closeServer(server, sockets),
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: { authenticate(token: string): string | null; gateway: CapabilityGateway },
): Promise<void> {
  const remote = request.socket.remoteAddress;
  if (!isLoopbackAddress(remote) || request.headers.origin) {
    respond(response, 401, {
      ok: false,
      code: "unauthorized",
      message: "Extension host is local only.",
    });
    return;
  }
  if (request.method !== "POST") {
    respond(response, 405, { ok: false, code: "unauthorized", message: "Method not allowed." });
    return;
  }
  const token = readBearerToken(request.headers.authorization);
  const pluginId = token ? options.authenticate(token) : null;
  if (!token || !pluginId) {
    respond(response, 401, { ok: false, code: "unauthorized", message: "Invalid host token." });
    return;
  }
  const auth: ExtensionTransportAuth = { token, pluginId };
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    respond(response, error === "too-large" ? 413 : 400, {
      ok: false,
      code: "invalid-input",
      message: "Invalid extension request body.",
    });
    return;
  }
  if (request.url === "/capability") {
    const parsed = extensionCapabilityRequestSchema.safeParse(body);
    if (!parsed.success) {
      respond(response, 400, {
        ok: false,
        code: "invalid-input",
        message: "Invalid extension capability request.",
      });
      return;
    }
    respond(response, 200, await options.gateway.call(parsed.data, auth));
    return;
  }
  if (request.url === "/contribute") {
    const parsed = extensionContributionRequestSchema.safeParse(body);
    if (!parsed.success) {
      respond(response, 400, {
        ok: false,
        code: "invalid-input",
        message: "Invalid extension contribution request.",
      });
      return;
    }
    respond(response, 200, await options.gateway.contribute(parsed.data, auth));
    return;
  }
  respond(response, 404, { ok: false, code: "unknown-capability", message: "Unknown route." });
}

function readBearerToken(header: string | undefined): string | null {
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared > EXTENSION_LOOPBACK_MAX_BODY_BYTES) throw "too-large";
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > EXTENSION_LOOPBACK_MAX_BODY_BYTES) throw "too-large";
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function respond(response: ServerResponse, status: number, payload: unknown): void {
  if (response.headersSent || response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

/** handler 自身失败时也给出确定的 500；连接已断开则直接销毁，不二次抛错。 */
function failClosed(response: ServerResponse): void {
  if (response.headersSent || response.writableEnded) {
    response.destroy();
    return;
  }
  respond(response, 500, {
    ok: false,
    code: "backend-error",
    message: "Extension host failed to handle the request.",
  });
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.close(finish);
    server.closeIdleConnections?.();
    // 挂起请求不会自己结束；给一个上限后主动断开，避免 stop() 永远等 close 回调。
    const timer = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      finish();
    }, 250);
    timer.unref?.();
  });
}
