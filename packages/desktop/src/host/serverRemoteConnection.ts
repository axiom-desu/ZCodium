import { WebSocket, type RawData } from "ws";
import { RemoteServiceAccess } from "@zcode/client";
import { ChannelClient, Emitter, SocketProtocol, VSBuffer, type ISocket } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import {
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  serverRemoteHostCapabilitySchema,
  serverRemoteInfoSchema,
  type ServerConnectOptions,
  type ServerRemoteInfo,
} from "@zcode/shared";
import {
  connectWebSocketOverDuplex,
  createReusableDuplexHttpAgent,
  requestJsonOverDuplex,
  type ServerRemoteDuplexFactory,
} from "./serverRemoteDuplexTransport.js";

interface ServerRemoteEndpoints {
  infoUrl: string;
  wsUrl: string;
  hostCapabilityUrl: string;
  hostWsUrl: string;
}

export interface ServerRemoteConnection {
  serverInfo: ServerRemoteInfo;
  services: IServiceAccessor;
  dispose(): void;
}

interface ServerRemoteConnectionOptions {
  signal?: AbortSignal;
  /** 只能在鉴权成功后提交成员事实；失败路径必须由调用方回收资源。 */
  commitMembership?(sourceServerId: string): Promise<void>;
  fetchImpl?: typeof fetch;
  onClose?: (event: { code: number; reason: string }) => void;
}

interface ServerRemoteDuplexConnectionOptions {
  ingressToken: string;
  createConnection: ServerRemoteDuplexFactory;
  onClose?: (event: { code: number; reason: string }) => void;
}

function appendEndpointPath(basePath: string, endpointPath: string): string {
  const normalizedBase = basePath.replace(/\/+$/g, "");
  return normalizedBase ? `${normalizedBase}${endpointPath}` : endpointPath;
}

function stripWebSocketEndpointPath(pathname: string): string {
  const normalizedPath = pathname.replace(/\/+$/g, "");
  if (normalizedPath.endsWith("/ws/host")) {
    return normalizedPath.slice(0, -"/ws/host".length);
  }
  if (normalizedPath.endsWith("/ws")) {
    return normalizedPath.slice(0, -"/ws".length);
  }
  return normalizedPath;
}

export function resolveServerRemoteEndpoints(serverUrl: string): ServerRemoteEndpoints {
  const trimmedUrl = serverUrl.trim();
  if (!trimmedUrl) {
    throw new Error("Server URL is required");
  }

  const infoUrl = new URL(trimmedUrl);
  const wsUrl = new URL(trimmedUrl);
  const hostCapabilityUrl = new URL(trimmedUrl);
  const hostWsUrl = new URL(trimmedUrl);
  const infoBasePath = stripWebSocketEndpointPath(infoUrl.pathname);
  const wsBasePath = stripWebSocketEndpointPath(wsUrl.pathname);
  const hostCapabilityBasePath = stripWebSocketEndpointPath(hostCapabilityUrl.pathname);
  const hostWsBasePath = stripWebSocketEndpointPath(hostWsUrl.pathname);

  switch (infoUrl.protocol) {
    case "http:":
    case "https:":
      wsUrl.protocol = infoUrl.protocol === "https:" ? "wss:" : "ws:";
      hostWsUrl.protocol = wsUrl.protocol;
      break;
    case "ws:":
    case "wss:":
      infoUrl.protocol = infoUrl.protocol === "wss:" ? "https:" : "http:";
      hostCapabilityUrl.protocol = infoUrl.protocol;
      break;
    default:
      throw new Error(`Unsupported server URL protocol: ${infoUrl.protocol}`);
  }

  infoUrl.pathname = appendEndpointPath(infoBasePath, "/api/server-info");
  wsUrl.pathname = appendEndpointPath(wsBasePath, "/ws");
  hostCapabilityUrl.pathname = appendEndpointPath(
    hostCapabilityBasePath,
    "/api/rpc-host-capability",
  );
  hostWsUrl.pathname = appendEndpointPath(hostWsBasePath, "/ws/host");
  infoUrl.search = "";
  wsUrl.search = "";
  hostCapabilityUrl.search = "";
  hostWsUrl.search = "";
  infoUrl.hash = "";
  wsUrl.hash = "";
  hostCapabilityUrl.hash = "";
  hostWsUrl.hash = "";

  return {
    infoUrl: infoUrl.toString(),
    wsUrl: wsUrl.toString(),
    hostCapabilityUrl: hostCapabilityUrl.toString(),
    hostWsUrl: hostWsUrl.toString(),
  };
}

/**
 * 直连 Source 的凭据只走 Authorization header。
 * 规范要求 token 永不进入 URL query，因此这里不构造带 token 的 URL。
 */
function authorizationHeaders(target: Pick<ServerConnectOptions, "token">): Record<string, string> {
  const token = target.token?.trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

function wrapNodeWebSocket(
  ws: WebSocket,
  onClose?: (event: { code: number; reason: string }) => void,
): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onSocketClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  const fireClosed = (code: number, reason: Buffer) => {
    onClose?.({ code, reason: reason.toString("utf8") });
    onSocketClose.fire();
    onEnd.fire();
  };

  ws.on("message", (raw: RawData) => {
    const data = Array.isArray(raw)
      ? Buffer.concat(raw)
      : Buffer.isBuffer(raw)
        ? raw
        : Buffer.from(raw);
    onData.fire(VSBuffer.wrap(new Uint8Array(data)));
  });
  ws.on("close", fireClosed);
  ws.on("error", () => {
    onSocketClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onSocketClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.buffer);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

function createNodeWebSocketServiceConnection(
  socket: WebSocket,
  virtualProjects: boolean,
  onClose?: ServerRemoteConnectionOptions["onClose"],
): { services: IServiceAccessor; dispose(): void } {
  const protocol = new SocketProtocol(wrapNodeWebSocket(socket, onClose));
  const client = new ChannelClient(protocol);
  const dispose = () => {
    // Bug 根因：仅关闭 socket 会让未完成的 RPC 永久 pending，旧 Provisioning 请求
    // 因而占住 Environment lane，新连接始终无法发布 attachment。由物理连接统一
    // 释放客户端与协议，让旧请求拒绝并沿现有同步失败路径收口；重复释放保持幂等。
    client.dispose();
    protocol.dispose();
    socket.off("close", dispose);
    socket.off("error", dispose);
  };
  socket.once("close", dispose);
  socket.once("error", dispose);
  return {
    // 只有握手声明 virtualProjects 才创建 Project channel 代理；旧 Source 保留 undefined，
    // 由装配层构造显式 legacy single-root 只读适配，而不是假 proxy。
    services: new RemoteServiceAccess(client, { virtualProjects }),
    dispose,
  };
}

async function fetchServerInfo(
  endpoints: ServerRemoteEndpoints,
  target: Pick<ServerConnectOptions, "token">,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<ServerRemoteInfo> {
  const response = await fetchImpl(endpoints.infoUrl, {
    headers: authorizationHeaders(target),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Server info request failed: ${response.status}`);
  }
  const parsed = serverRemoteInfoSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Server info response is invalid");
  }
  return parsed.data;
}

async function fetchHostCapability(
  endpoints: ServerRemoteEndpoints,
  target: Pick<ServerConnectOptions, "token">,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetchImpl(endpoints.hostCapabilityUrl, {
    method: "POST",
    headers: authorizationHeaders(target),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Host capability request failed: ${response.status}`);
  }
  const parsed = serverRemoteHostCapabilitySchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Host capability response is invalid");
  }
  return parsed.data.capability;
}

function connectNodeWebSocket(
  wsUrl: string,
  target: Pick<ServerConnectOptions, "token">,
  capability: string,
  options: ServerRemoteConnectionOptions,
  virtualProjects: boolean,
): Promise<{
  socket: WebSocket;
  rpc: ReturnType<typeof createNodeWebSocketServiceConnection>;
}> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, {
      headers: {
        ...authorizationHeaders(target),
        [ZCODE_RPC_HOST_CAPABILITY_HEADER]: capability,
      },
    });
    let settled = false;
    const abort = () => {
      socket.terminate();
      reject(options.signal?.reason ?? new Error("远程连接已取消"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const releaseAbort = () => options.signal?.removeEventListener("abort", abort);

    socket.once("error", (error) => {
      releaseAbort();
      if (!settled) {
        reject(error);
      }
    });
    socket.once("close", (code, reason) => {
      releaseAbort();
      if (!settled) {
        reject(
          new Error(
            reason.length > 0
              ? `WebSocket closed before ready: ${reason.toString("utf8")}`
              : `WebSocket closed before ready (${code})`,
          ),
        );
      }
    });
    socket.once("open", () => {
      releaseAbort();
      settled = true;
      resolve({
        socket,
        rpc: createNodeWebSocketServiceConnection(socket, virtualProjects, options.onClose),
      });
    });
  });
}

/**
 * 直连已运行的 Source Server：HTTP Bearer info/capability + 同一物理 WS 上的 RPC。
 * `capabilities.virtualProjects` 只按握手声明开放 Project channel。
 */
export async function connectServerRemote(
  target: ServerConnectOptions,
  options: ServerRemoteConnectionOptions = {},
): Promise<ServerRemoteConnection> {
  options.signal?.throwIfAborted();
  const endpoints = resolveServerRemoteEndpoints(target.url);
  const fetchImpl = options.fetchImpl ?? fetch;
  const serverInfo = await fetchServerInfo(endpoints, target, fetchImpl, options.signal);
  options.signal?.throwIfAborted();
  const capability = await fetchHostCapability(endpoints, target, fetchImpl, options.signal);
  options.signal?.throwIfAborted();
  const { socket, rpc } = await connectNodeWebSocket(
    endpoints.hostWsUrl,
    target,
    capability,
    options,
    serverInfo.capabilities.virtualProjects === true,
  );

  try {
    options.signal?.throwIfAborted();
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Server closed during handshake");
    await options.commitMembership?.(serverInfo.serverId);
    options.signal?.throwIfAborted();
    if (socket.readyState !== WebSocket.OPEN)
      throw new Error("Server closed during membership commit");
    return {
      serverInfo,
      services: rpc.services,
      dispose() {
        rpc.dispose();
        socket.close();
      },
    };
  } catch (error) {
    // 成员提交失败/连接取消时资源尚未发布，当前调用必须回收 socket。
    rpc.dispose();
    socket.terminate();
    throw error;
  }
}

/**
 * 经单一可复用 Duplex（SSH 通道或 WSL/Docker proxy-stdio）完成同一套鉴权握手。
 * info、capability 与 WS upgrade 共享同一个 keep-alive 连接；关闭时一并释放。
 */
export async function connectServerRemoteOverDuplex(
  options: ServerRemoteDuplexConnectionOptions,
): Promise<ServerRemoteConnection> {
  const ingressToken = options.ingressToken.trim();
  if (!ingressToken) throw new Error("Source Server ingress token is required");
  const endpoints = resolveServerRemoteEndpoints("http://source-server.invalid");
  const authorization = { authorization: `Bearer ${ingressToken}` };
  const agent = await createReusableDuplexHttpAgent(options.createConnection);
  let rpc: ReturnType<typeof createNodeWebSocketServiceConnection> | undefined;
  try {
    const infoResponse = await requestJsonOverDuplex<unknown>({
      url: endpoints.infoUrl,
      headers: authorization,
      createConnection: options.createConnection,
      agent,
    });
    if (infoResponse.status < 200 || infoResponse.status >= 300) {
      throw new Error(`Server info request failed: ${infoResponse.status}`);
    }
    const serverInfo = serverRemoteInfoSchema.safeParse(infoResponse.body);
    if (!serverInfo.success) throw new Error("Server info response is invalid");
    const capabilityResponse = await requestJsonOverDuplex<unknown>({
      url: endpoints.hostCapabilityUrl,
      method: "POST",
      headers: authorization,
      createConnection: options.createConnection,
      agent,
    });
    if (capabilityResponse.status < 200 || capabilityResponse.status >= 300) {
      throw new Error(`Host capability request failed: ${capabilityResponse.status}`);
    }
    const capability = serverRemoteHostCapabilitySchema.safeParse(capabilityResponse.body);
    if (!capability.success) throw new Error("Host capability response is invalid");
    const socket = await connectWebSocketOverDuplex({
      url: endpoints.hostWsUrl,
      headers: {
        ...authorization,
        [ZCODE_RPC_HOST_CAPABILITY_HEADER]: capability.data.capability,
      },
      createConnection: options.createConnection,
      agent,
      onSocketCreated: (webSocket) => {
        rpc = createNodeWebSocketServiceConnection(
          webSocket,
          serverInfo.data.capabilities.virtualProjects === true,
          options.onClose,
        );
      },
    });
    if (!rpc) throw new Error("Source Server RPC protocol was not initialized");
    return {
      serverInfo: serverInfo.data,
      services: rpc.services,
      dispose() {
        rpc?.dispose();
        socket.terminate();
        agent.destroy();
      },
    };
  } catch (error) {
    rpc?.dispose();
    agent.destroy();
    throw error;
  }
}
