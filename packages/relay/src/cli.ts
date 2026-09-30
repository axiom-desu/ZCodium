#!/usr/bin/env node
import { existsSync } from "node:fs";
import { startRelayServer } from "./server.js";

/**
 * zcode-relay CLI：用户自托管的手机远控 relay。
 *
 * 用法（本机直接跑）：
 *   ZCODE_RELAY_MOBILE_DIR=../web/dist node src/cli.ts
 * 常规部署见 packages/relay/README.md（Docker / Caddy 前置 TLS）。
 */

const logger = {
  info: (message: string, fields?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: "info", message, ...fields })),
  warn: (message: string, fields?: Record<string, unknown>) =>
    console.warn(JSON.stringify({ level: "warn", message, ...fields })),
};

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

// per-IP 轻量限速：连接每分钟 20 次、帧每 10s 600 条；超限直接关闭。
const connectBuckets = new Map<string, { count: number; resetAt: number }>();
const frameBuckets = new Map<string, { count: number; resetAt: number }>();
function allow(
  buckets: Map<string, { count: number; resetAt: number }>,
  ip: string,
  limit: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

async function main(): Promise<void> {
  const mobileDir = process.env.ZCODE_RELAY_MOBILE_DIR?.trim() || null;
  const handle = await startRelayServer({
    port: envNumber("ZCODE_RELAY_PORT", 8443),
    host: process.env.ZCODE_RELAY_HOST?.trim() || "0.0.0.0",
    path: process.env.ZCODE_RELAY_PATH?.trim() || "/ws",
    maxPhysicalFrameBytes: envNumber("ZCODE_RELAY_MAX_FRAME_BYTES", 1024 * 1024),
    pairTtlMs: envNumber("ZCODE_RELAY_PAIR_TTL_HOURS", 24) * 60 * 60 * 1000,
    mobileDir:
      mobileDir && existsSync(mobileDir)
        ? mobileDir
        : (() => {
            logger.warn("relay: mobile dir missing; page hosting disabled", { mobileDir });
            return null;
          })(),
    logger,
    rateLimiter: {
      allowConnect: (ip) => allow(connectBuckets, ip, 20, 60_000),
      allowFrame: (ip) => allow(frameBuckets, ip, 600, 10_000),
    },
  });
  logger.info("relay: ready", {
    port: handle.port,
    mobileDir: mobileDir ?? "none",
    docs: "https://github.com/axiom-desu/ZCodium/blob/main/.agents/specs/web-remote-control.md",
  });

  const shutdown = async (signal: string) => {
    logger.info("relay: shutting down", { signal });
    await handle.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void main().catch((error) => {
  logger.warn("relay: failed to start", {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
