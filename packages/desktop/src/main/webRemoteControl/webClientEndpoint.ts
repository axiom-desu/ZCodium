import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { Emitter, SocketProtocol, VSBuffer, type IDisposable, type ISocket } from "@zcode/rpc";
import type { WebRemoteControlLogger } from "./logger.js";

/**
 * 浏览器（手机/平板）远控端点（方案 B 的 B1 片）。
 *
 * 职责只有三件，且都不持有业务状态：
 * 1. 托管随包 Web 客户端静态资源（`resources/web-remote`），`/` 是 index.html；
 * 2. 用既有配对事实（sid + passHash + 时间戳）兑换同源 HttpOnly 签名 Cookie；
 * 3. 把 `/ws` 升级成一条既有窗口 Host attachment 的字节桥（`SocketProtocol` ⇄ attachment）。
 *
 * 为什么不用 `packages/server` 的 entry-http：那会 `createLocalServices()` 起第二个 runtime，
 * 同 workspace 双写 session DB/队列，违反单一 owner。这里必须复用桌面已有的 Host。
 */

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

const COOKIE_NAME = "zcode_web_client";
const COOKIE_TTL_MS = 12 * 60 * 60 * 1000;
const WS_PATH = "/ws";
const SERVER_INFO_PATH = "/api/server-info";

/** 一条 Host attachment 的字节通道；生产实现包 `MessagePortProtocol`，测试用内存管道。 */
export interface WebClientRpcAttachment {
  /** 订阅 Host → 浏览器方向的消息。 */
  onMessage(listener: (buffer: VSBuffer) => void): IDisposable;
  /** 浏览器 → Host 方向。 */
  send(buffer: VSBuffer): void;
  /**
   * 订阅完成后的握手点。生产实现为空：Host 在另一个进程，Initialize 天然晚于订阅；
   * 同进程测试用它按真实顺序启动对端 ChannelServer。
   */
  start?(): void;
  dispose(): void;
}

export interface WebClientPairingCredentials {
  deviceSid: string;
  passHash: string;
  timestamp: number;
}

export interface WebClientEndpointOptions {
  logger: WebRemoteControlLogger;
  appVersion: string;
  serverId: string;
  /** 随包 web 客户端目录（含 index.html）；缺失时首页返回 503，不影响其它路由。 */
  staticRoot: string | null;
  /** 配对事实的唯一来源仍是 manager 的内存配对表。 */
  authorizePairing(credentials: WebClientPairingCredentials): boolean;
  /** 由调用方解析目标窗口并打开既有 Host attachment；必须同步返回，避免首帧竞态。 */
  openAttachment(input: { deviceSid: string }): WebClientRpcAttachment;
  /** 0 = 随机端口。 */
  port?: number;
  /** 覆盖绑定地址（测试用 loopback 单地址）。 */
  bindAddresses?: readonly string[];
}

export interface WebClientEndpointInfo {
  port: number;
  baseUrls: string[];
}

export interface WebClientEndpoint {
  start(): Promise<WebClientEndpointInfo>;
  stop(): Promise<void>;
  info(): WebClientEndpointInfo | null;
}

interface CookiePayload {
  deviceSid: string;
  expiresAt: number;
}

/** 默认绑定 loopback + 本机 IPv4（LAN）；不绑 0.0.0.0，公网暴露必须由用户显式配置。 */
function resolveLanAddresses(): string[] {
  const addresses = new Set<string>(["127.0.0.1"]);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.add(entry.address);
    }
  }
  return [...addresses];
}

function contentTypeFor(filePath: string): string {
  return STATIC_CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** `/` 与未知路径都回 index.html；只允许命中 staticRoot 内的真实文件。 */
async function resolveStaticFile(root: string, urlPath: string): Promise<string | null> {
  const [rawPath = "/"] = urlPath.split("?");
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const rootPath = resolve(root);
  const candidate = resolve(join(rootPath, normalize(relativePath)));
  if (candidate !== rootPath && !candidate.startsWith(`${rootPath}${sep}`)) return null;
  const entry = await stat(candidate).catch(() => null);
  if (entry?.isFile()) return candidate;
  // SPA 回退：非资源扩展名一律回 index.html，避免前端路由 404。
  if (extname(relativePath)) return null;
  const fallback = join(rootPath, "index.html");
  return (await stat(fallback).catch(() => null))?.isFile() ? fallback : null;
}

/** ws → ISocket：与 `packages/server` 的 wrapWebSocket 同一约定（一条 WS 帧 = 一条协议消息）。 */
function createWebSocketSocket(socket: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buffer = Buffer.isBuffer(raw)
      ? raw
      : Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buffer)));
  });
  socket.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  socket.on("error", () => {
    onClose.fire();
  });
  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer) {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(buffer.buffer);
    },
    end() {
      socket.close();
    },
    async drain() {},
    dispose() {
      onData.dispose();
      onClose.dispose();
      onEnd.dispose();
      socket.close();
    },
  };
}

export function createWebClientEndpoint(options: WebClientEndpointOptions): WebClientEndpoint {
  const { logger } = options;
  // 端点进程内的签名密钥：重启即失效全部 Cookie，不持久化任何鉴权事实。
  const cookieSecret = randomBytes(32);
  const servers: Server[] = [];
  const wssList: WebSocketServer[] = [];
  let info: WebClientEndpointInfo | null = null;

  function sign(payload: CookiePayload): string {
    return createHmac("sha256", cookieSecret)
      .update(`${payload.deviceSid}.${payload.expiresAt}`)
      .digest("base64url");
  }

  function serializeCookie(payload: CookiePayload): string {
    const value = `${payload.deviceSid}.${payload.expiresAt}.${sign(payload)}`;
    // 手机通过 LAN HTTP 访问，Secure 会让 Cookie 直接被丢弃；同源 + HttpOnly + SameSite 已足够。
    return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
      COOKIE_TTL_MS / 1000,
    )}`;
  }

  function readCookie(header: string | undefined): CookiePayload | null {
    if (!header) return null;
    for (const part of header.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name !== COOKIE_NAME) continue;
      const value = rest.join("=");
      const segments = value.split(".");
      if (segments.length !== 3) return null;
      const [deviceSid, expiresAtRaw, signature] = segments as [string, string, string];
      const expiresAt = Number(expiresAtRaw);
      if (!deviceSid || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
      const expected = Buffer.from(sign({ deviceSid, expiresAt }));
      const received = Buffer.from(signature);
      if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
      return { deviceSid, expiresAt };
    }
    return null;
  }

  async function serveStatic(response: ServerResponse, urlPath: string): Promise<void> {
    if (!options.staticRoot) {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      response.end("Web client assets are not available in this build");
      return;
    }
    const filePath = await resolveStaticFile(options.staticRoot, urlPath);
    if (!filePath) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentTypeFor(filePath),
      // 客户端是随包产物：入口不缓存，资源可按内容寻址缓存。
      "cache-control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=3600",
    });
    response.end(body);
  }

  function handlePairing(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
    const deviceSid = url.searchParams.get("sid")?.trim();
    const passHash = url.searchParams.get("hash")?.trim();
    const timestamp = Number(url.searchParams.get("t"));
    if (!deviceSid || !passHash) return false;
    if (!options.authorizePairing({ deviceSid, passHash, timestamp })) {
      response.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      response.end("Pairing link is invalid or expired. Generate a new QR code on the desktop.");
      return true;
    }
    const payload: CookiePayload = { deviceSid, expiresAt: Date.now() + COOKIE_TTL_MS };
    // 302 到干净的 `/`：配对凭证不留在地址栏、历史和分享面板里。
    response.writeHead(302, { "set-cookie": serializeCookie(payload), location: "/" });
    response.end();
    logger.info("[web-client-remote] paired browser device", { deviceSid });
    void request;
    return true;
  }

  function createRequestHandler(server: Server) {
    return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
        response.end("Method not allowed");
        return;
      }
      if (url.pathname === SERVER_INFO_PATH) {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(
          JSON.stringify({
            serverId: options.serverId,
            version: options.appVersion,
            authRequired: true,
            // 浏览器客户端通过 RPC 读取真实工作区，这里不复制一份业务投影。
            workspaces: [],
          }),
        );
        return;
      }
      const cookie = readCookie(request.headers.cookie);
      if (!cookie && handlePairing(request, response, url)) return;
      if (!cookie) {
        response.writeHead(401, { "content-type": "text/html; charset=utf-8" });
        response.end(
          '<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">' +
            '<body style="font:15px system-ui;padding:24px">' +
            '<h1 style="font-size:16px">需要在电脑上重新扫码</h1>' +
            "<p>这个链接已失效，请回到桌面端的手机远控面板生成新的二维码。</p></body>",
        );
        return;
      }
      await serveStatic(response, url.pathname);
      void server;
    };
  }

  return {
    async start() {
      const addresses = options.bindAddresses ?? resolveLanAddresses();
      let boundPort = options.port ?? 0;
      const started: Server[] = [];
      for (const address of addresses) {
        const server = createServer((request, response) => {
          void createRequestHandler(server)(request, response);
        });
        const wss = new WebSocketServer({ noServer: true });
        server.on("upgrade", (request, socket, head) => {
          const url = new URL(request.url ?? "/", "http://localhost");
          if (url.pathname !== WS_PATH) {
            socket.destroy();
            return;
          }
          const cookie = readCookie(request.headers.cookie);
          if (!cookie) {
            socket.write("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
            socket.destroy();
            return;
          }
          wss.handleUpgrade(request, socket, head, (ws) => {
            attachSocket(ws, cookie.deviceSid);
          });
        });
        await new Promise<void>((resolveListen, rejectListen) => {
          server.once("error", rejectListen);
          server.listen(boundPort || options.port || 0, address, () => {
            server.off("error", rejectListen);
            const actual = server.address();
            if (typeof actual === "object" && actual) boundPort = actual.port;
            resolveListen();
          });
        });
        started.push(server);
        wssList.push(wss);
      }
      if (started.length === 0) throw new Error("Web client endpoint could not bind any address");
      servers.push(...started);
      const baseUrls = addresses.map((address) => `http://${address}:${boundPort}/`);
      baseUrls.sort((a, b) => (a.includes("127.0.0.1") ? -1 : b.includes("127.0.0.1") ? 1 : 0));
      info = { port: boundPort, baseUrls };
      logger.info("[web-client-remote] listening", { port: boundPort, addresses });
      return info;
    },

    async stop() {
      // 先终止已升级的 WS，否则 server.close() 会一直等这些长连接。
      for (const wss of wssList.splice(0)) {
        for (const client of wss.clients) client.terminate();
        wss.close();
      }
      await Promise.all(
        servers.splice(0).map(
          (server) =>
            new Promise<void>((resolveClose) => {
              server.close(() => resolveClose());
              server.closeAllConnections?.();
            }),
        ),
      );
      info = null;
    },

    info() {
      return info;
    },
  };

  /**
   * 打开 attachment 需要 await，但客户端在 WS `open` 之后立刻发 Initialize。
   * 必须同步注册协议监听并缓冲，等 attachment 就绪再回放，否则首帧必丢。
   */
  function attachSocket(ws: WebSocket, deviceSid: string): void {
    const socket = createWebSocketSocket(ws);
    const protocol = new SocketProtocol(socket);
    let attachment: WebClientRpcAttachment;
    try {
      attachment = options.openAttachment({ deviceSid });
    } catch (error) {
      logger.warn("[web-client-remote] attachment open failed", {
        deviceSid,
        message: error instanceof Error ? error.message : String(error),
      });
      // 打不开 attachment 时立即关闭，避免客户端对着空连接无限重试。
      ws.close(1011, "attachment-unavailable");
      socket.dispose();
      return;
    }
    // 先订阅、再让对端启动：否则 Host 的 Initialize 会落在订阅之前。
    const hostSubscription = attachment.onMessage((buffer) => protocol.send(buffer));
    const inbound = protocol.onMessage((buffer) => attachment.send(buffer));
    attachment.start?.();
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      inbound.dispose();
      hostSubscription.dispose();
      attachment.dispose();
      socket.dispose();
    };
    ws.on("close", dispose);
    ws.on("error", dispose);
    logger.info("[web-client-remote] browser rpc attached", { deviceSid });
  }
}
