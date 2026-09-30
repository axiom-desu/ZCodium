import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import type { WebRemoteControlLogger } from "./logger.js";

/**
 * 移动端 web 应用的静态托管根目录解析：
 * 1. `ZCODE_WEB_REMOTE_MOBILE_DIR` 显式覆盖（dev / 自托管部署）；
 * 2. 正式包 `process.resourcesPath/web-remote`（electron-builder extraResources）；
 * 3. 仓库内 `packages/web/dist`（dev 直跑桌面时的兜底）。
 *
 * 解析不到目录时 fail-closed：移动页返回 503，远控其余能力（同网 API）不受影响。
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
  ".map": "application/json; charset=utf-8",
};

export function resolveMobileAppRoot(): string | null {
  const candidates = [
    process.env.ZCODE_WEB_REMOTE_MOBILE_DIR?.trim(),
    process.resourcesPath ? resolve(process.resourcesPath, "web-remote") : undefined,
    resolve(process.cwd(), "packages/web/dist"),
    resolve(process.cwd(), "../web/dist"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "mobile.html")) || existsSync(join(candidate, "mobile"))) {
      return candidate;
    }
  }
  return null;
}

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** 把请求路径收敛到静态根内，拒绝越界访问。 */
function resolveStaticFilePath(root: string, urlPath: string): string | null {
  const [rawPath = "/"] = urlPath.split("?");
  const decoded = decodeURIComponent(rawPath);
  const relative = decoded === "/" ? "/mobile.html" : decoded;
  const target = resolve(join(root, normalize(relative)));
  if (!target.startsWith(resolve(root))) {
    return null;
  }
  return target;
}

export function createMobileAppStaticHandler(params: { logger: WebRemoteControlLogger }) {
  const root = resolveMobileAppRoot();
  if (!root) {
    params.logger.warn("[web-remote-control] mobile app bundle not found; QR page will return 503");
  }
  const mobileHtmlPath = root ? join(root, "mobile.html") : null;
  const mobileDir = root && existsSync(join(root, "mobile")) ? join(root, "mobile") : null;

  return async function handleMobileAppRequest(
    urlPath: string,
  ): Promise<{ status: number; body?: string | Buffer; contentType?: string }> {
    if (!root) {
      return {
        status: 503,
        body: "Mobile remote control bundle is not built. Run `pnpm --filter @zcode/web build` first.",
        contentType: "text/plain; charset=utf-8",
      };
    }
    // SPA：未命中文件时回退 mobile.html（深链 /remote/task/xxx 不 404）。
    const candidates = [
      resolveStaticFilePath(root, urlPath),
      mobileDir ? resolveStaticFilePath(mobileDir, urlPath) : null,
      mobileHtmlPath,
    ].filter((value): value is string => Boolean(value));
    for (const candidate of candidates) {
      try {
        const body = await readFile(candidate);
        return { status: 200, body, contentType: contentTypeFor(candidate) };
      } catch {
        continue;
      }
    }
    return { status: 404, body: "Not found", contentType: "text/plain; charset=utf-8" };
  };
}
