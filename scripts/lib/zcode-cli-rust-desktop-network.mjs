// M8 桌面 E2E 的 fail-closed 网络守卫。
//
// 设计：本地 HTTP 代理是唯一出口，只允许 loopback 目标；任何非 loopback 请求被 403/断开并
// 记录，作为“本轮没有任何真实外网/凭据出网”的证据。Chromium 通过 --proxy-server 与
// --host-resolver-rules 接入；renderer 另有 route 白名单。Node 侧尽力通过 ZCODE_HTTP_PROXY，
// 局限在 evidence 中如实标注。
import { createServer } from "node:http";
import { once } from "node:events";
import { isIP } from "node:net";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopbackHostname(hostname) {
  if (!hostname) return false;
  if (LOOPBACK_HOSTS.has(hostname)) return true;
  if (hostname.startsWith("[") && hostname.endsWith("]") && hostname.slice(1, -1) === "::1") {
    return true;
  }
  return isIP(hostname) === 4 && hostname.startsWith("127.");
}

export function isAllowedRendererUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (["file:", "data:", "blob:", "devtools:", "zcode-sandbox:", "about:"].includes(url.protocol)) {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "ws:") {
    return false;
  }
  return isLoopbackHostname(url.hostname);
}

/**
 * 起一个 fail-closed 代理。返回的 `denied` 记录所有被拒绝的非 loopback 目标。
 * 代理本身只监听 127.0.0.1，不对外暴露。
 */
export async function startFailClosedProxy({ label = "m8" } = {}) {
  const denied = [];
  const allowed = [];
  const noteDenied = (target) => {
    denied.push({ target, at: Date.now() });
  };
  const server = createServer((request, response) => {
    // 正常路径下 loopback 会由 --proxy-bypass-list / NO_PROXY 绕过，不经过代理；
    // 若仍到达，只对 loopback 目标做透明拒绝（我们不转发），保证代理不成为出网跳板。
    noteDenied(`http:${request.headers.host ?? "unknown"}`);
    response.writeHead(403, { "Content-Type": "text/plain" });
    response.end("M8 E2E network egress is fail-closed\n");
  });
  server.on("connect", (request, socket) => {
    const target = request.url ?? "unknown";
    const hostname = target.split(":")[0]?.replace(/^\[|\]$/g, "");
    if (isLoopbackHostname(hostname)) {
      allowed.push({ target, at: Date.now() });
      // loopback 在正常情况下应已绕过代理；仅保留记录，不做任何真实转发。
      socket.destroy();
      return;
    }
    noteDenied(`connect:${target}`);
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    label,
    url: `http://127.0.0.1:${port}`,
    get denied() {
      return denied;
    },
    get allowed() {
      return allowed;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolveClose) => {
        const timer = setTimeout(resolveClose, 2_000);
        server.close(() => {
          clearTimeout(timer);
          resolveClose();
        });
      });
    },
  };
}

/**
 * 主进程兜底：在 Electron main 里对所有 session 安装 webRequest 拦截。
 * 这不是修改产品代码，而是测试运行时的注入；必须在首个窗口出现后、任何业务请求前调用。
 */
export async function installMainProcessNetworkGuard(electronApp, { blocked }) {
  await electronApp.evaluate(({ session }, sinkName) => {
    const allowed = (rawUrl) => {
      try {
        const url = new URL(rawUrl);
        if (
          ["file:", "data:", "blob:", "devtools:", "zcode-sandbox:", "about:"].includes(
            url.protocol,
          )
        ) {
          return true;
        }
        if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return false;
        const host = url.hostname;
        return host === "127.0.0.1" || host === "localhost" || host === "::1";
      } catch {
        return false;
      }
    };
    globalThis[sinkName] = globalThis[sinkName] ?? [];
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      if (allowed(details.url)) {
        callback({});
        return;
      }
      globalThis[sinkName].push(details.url);
      callback({ cancel: true });
    });
  }, blocked);
}
