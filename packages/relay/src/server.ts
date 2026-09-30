import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { webRemoteControlClientToEndpointFrameSchema } from "@zcode/shared";
import { RelayPairingRegistry, type RelayLogger } from "./registry.js";

/**
 * ZCode 手机远控 relay（用户自托管）：HTTP 托管移动端页面 + WS `/ws` 配对与转发。
 *
 * - 零业务状态：重启即全部失效，桌面/手机按重连流程恢复；
 * - TLS 由前置（Caddy/traefik/cloudflared）终结，本服务只监听明文 WS；
 * - 端口/路径/上限/TTL/静态目录全部走环境变量。
 */

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

export interface RelayServerOptions {
  port: number;
  host: string;
  path: string;
  maxPhysicalFrameBytes: number;
  pairTtlMs: number;
  mobileDir: string | null;
  logger: RelayLogger;
  rateLimiter: {
    allowConnect(ip: string): boolean;
    allowFrame(ip: string): boolean;
  };
}

export interface RelayServerHandle {
  port: number;
  close(): Promise<void>;
}

export async function startRelayServer(options: RelayServerOptions): Promise<RelayServerHandle> {
  const registry = new RelayPairingRegistry({
    logger: options.logger,
    maxPhysicalFrameBytes: options.maxPhysicalFrameBytes,
    pairTtlMs: options.pairTtlMs,
    allowConnect: options.rateLimiter.allowConnect,
    allowFrame: options.rateLimiter.allowFrame,
  });
  const wss = new WebSocketServer({ noServer: true });
  const sweep = setInterval(() => registry.sweepExpired(), 60 * 60 * 1000);
  sweep.unref?.();

  const server: Server = createServer((req, res) => handleHttp(req, res, options, registry));
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== options.path) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void attachClient(ws, req.socket.remoteAddress ?? "unknown");
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port, options.host, () => resolveListen());
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : options.port;
  options.logger.info("relay: listening", { port, path: options.path, host: options.host });

  return {
    port,
    async close() {
      clearInterval(sweep);
      for (const client of wss.clients) {
        client.close(1001, "relay-shutdown");
      }
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };

  async function attachClient(ws: WebSocket, ip: string): Promise<void> {
    let entry: ReturnType<RelayPairingRegistry["lookup"]> | undefined;
    let role: "device" | "mobile" | undefined;
    if (!options.rateLimiter.allowConnect(ip)) {
      ws.close(4008, "rate-limited");
      return;
    }

    ws.on("message", (raw) => {
      if (!options.rateLimiter.allowFrame(ip)) {
        ws.close(4008, "rate-limited");
        return;
      }
      const text = typeof raw === "string" ? raw : raw.toString();
      if (Buffer.byteLength(text) > options.maxPhysicalFrameBytes) {
        options.logger.warn("relay: oversize frame dropped", {
          ip,
          bytes: Buffer.byteLength(text),
        });
        send(ws, { type: "error", code: "WRONG_PARAM", message: "frame too large" });
        ws.close(4009, "oversize");
        return;
      }
      let parsed: ReturnType<typeof webRemoteControlClientToEndpointFrameSchema.safeParse>;
      try {
        parsed = webRemoteControlClientToEndpointFrameSchema.safeParse(JSON.parse(text));
      } catch {
        send(ws, { type: "error", code: "WRONG_PARAM", message: "invalid json" });
        ws.close(4001, "WRONG_PARAM");
        return;
      }
      if (!parsed.success) {
        send(ws, { type: "error", code: "WRONG_PARAM", message: "invalid frame" });
        ws.close(4001, "WRONG_PARAM");
        return;
      }
      handleFrame(ws, ip, parsed.data).catch((error) => {
        options.logger.warn("relay: frame handling failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });

    ws.on("close", () => {
      if (!entry) return;
      const unbound = registry.unbind(entry, ws);
      if (unbound === "mobile" && entry.device) {
        // 通知桌面：手机已离开，回到 waiting。
        send(entry.device, { type: "pair_status_ack", pair_status: "waiting" });
      }
    });
    ws.on("error", () => ws.close(1011, "internal"));

    async function handleFrame(
      socket: WebSocket,
      clientIp: string,
      frame: Record<string, unknown>,
    ): Promise<void> {
      const type = frame.type;
      switch (type) {
        case "device_register_init": {
          const passHash = String(frame.pass_hash ?? "");
          if (!passHash) {
            fail(socket, "WRONG_PARAM");
            return;
          }
          const deviceSid = registry.register(passHash);
          send(socket, { type: "device_register_ack", device_sid: deviceSid });
          return;
        }
        case "auth_init": {
          const frameRole = frame.role === "mobile" ? "mobile" : "device";
          const deviceSid = String(frame.device_sid ?? "");
          const candidate = registry.lookup(deviceSid);
          if (!candidate) {
            fail(socket, "AUTH_FAILED");
            return;
          }
          entry = candidate;
          role = frameRole;
          const nonce = registry.issueChallenge(entry, frameRole);
          send(socket, { type: "auth_challenge", nonce });
          return;
        }
        case "auth_response": {
          if (!entry || !role) {
            fail(socket, "AUTH_FAILED");
            return;
          }
          if (!registry.verifyProof(entry, role, String(frame.proof ?? ""))) {
            fail(socket, "AUTH_FAILED");
            return;
          }
          registry.bindRole(entry, role, socket);
          entry.pairStatus = role === "mobile" ? "matched" : entry.pairStatus;
          send(socket, {
            type: "auth_ack",
            pair_status: registry.pairStatusOf(entry),
          });
          if (role === "mobile" && entry.device) {
            send(entry.device, { type: "pair_status_ack", pair_status: "matched" });
          }
          options.logger.info("relay: authenticated", {
            role,
            clientIp,
            deviceSidSuffix: entry.deviceSid.slice(-6),
            pairStatus: registry.pairStatusOf(entry),
          });
          return;
        }
        case "pair_status_query": {
          if (!entry) {
            fail(socket, "AUTH_FAILED");
            return;
          }
          registry.touch(entry);
          send(socket, { type: "pair_status_ack", pair_status: registry.pairStatusOf(entry) });
          return;
        }
        case "data": {
          if (!entry || !role) {
            fail(socket, "AUTH_FAILED");
            return;
          }
          registry.touch(entry);
          registry.forward(role, entry, frame.payload);
          return;
        }
        case "device_unregister": {
          // 桌面刷新配对/销毁：立即作废该 sid 的全部配对关系。
          const target = registry.lookup(String(frame.device_sid ?? ""));
          if (target) {
            registry.drop(target);
            options.logger.info("relay: device unregistered", {
              deviceSidSuffix: target.deviceSid.slice(-6),
            });
          }
          return;
        }
        default:
          fail(socket, "WRONG_PARAM");
      }
    }
  }
}

function send(ws: WebSocket, frame: unknown): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(frame));
}

function fail(ws: WebSocket, code: "AUTH_FAILED" | "WRONG_PARAM" | "INTERNAL"): void {
  send(ws, { type: "error", code });
  ws.close(4001, code);
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  options: RelayServerOptions,
  registry: RelayPairingRegistry,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "ok", ...registry.stats() }));
    return;
  }
  if (!options.mobileDir) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      "Mobile app directory is not configured. Set ZCODE_RELAY_MOBILE_DIR to the built @zcode/web dist (contains mobile.html).\n",
    );
    return;
  }
  const root = resolve(options.mobileDir);
  const [rawPath = "/"] = url.pathname.split("?");
  const relative = rawPath === "/" ? "/mobile.html" : rawPath;
  const target = resolve(join(root, normalize(decodeURIComponent(relative))));
  if (!target.startsWith(root)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden\n");
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    // SPA 回退：深链回 mobile.html。
    try {
      const fallback = await readFile(join(root, "mobile.html"));
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(fallback);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found\n");
    }
  }
}
