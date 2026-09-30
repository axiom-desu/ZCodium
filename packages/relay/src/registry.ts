import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { WebSocket } from "ws";

/**
 * relay 配对注册表与 wire 帧处理（端点侧）。
 *
 * 边界（spec）：只做鉴权、配对、心跳、转发；零业务状态、零持久化。
 * 契约单一事实源在 `@zcode/shared` 的 webRemoteControl 模块。
 */

const DEVICE_SID_BYTES = 24;
const NONCE_TTL_MS = 60_000;
const HEARTBEAT_HINT_MS = 10_000;

export interface RelayPairEntry {
  deviceSid: string;
  passHash: string;
  device?: WebSocket;
  mobile?: WebSocket;
  nonce?: { value: string; role: "device" | "mobile"; expiresAt: number };
  pairStatus: "waiting" | "matched";
  lastSeenAt: number;
  refreshAt: number;
}

export type RelayLogger = {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
};

export interface RelayRegistryOptions {
  logger: RelayLogger;
  maxPhysicalFrameBytes: number;
  pairTtlMs: number;
  /** per-IP 连接与帧限速判定；超限返回 false（调用方负责关闭）。 */
  allowConnect(ip: string): boolean;
  allowFrame(ip: string): boolean;
}

export class RelayPairingRegistry {
  private readonly pairs = new Map<string, RelayPairEntry>();

  constructor(private readonly options: RelayRegistryOptions) {}

  get size(): number {
    return this.pairs.size;
  }

  stats(): { pairs: number; devices: number; mobiles: number } {
    let devices = 0;
    let mobiles = 0;
    for (const entry of this.pairs.values()) {
      if (entry.device) devices += 1;
      if (entry.mobile) mobiles += 1;
    }
    return { pairs: this.pairs.size, devices, mobiles };
  }

  /** 设备注册：生成不可枚举 sid，落 passHash（仅内存）。 */
  register(passHash: string): string {
    const deviceSid = randomBytes(DEVICE_SID_BYTES).toString("base64url");
    const now = Date.now();
    this.pairs.set(deviceSid, {
      deviceSid,
      passHash,
      pairStatus: "waiting",
      lastSeenAt: now,
      refreshAt: now + this.options.pairTtlMs,
    });
    this.options.logger.info("relay: device registered", { deviceSidSuffix: deviceSid.slice(-6) });
    return deviceSid;
  }

  issueChallenge(entry: RelayPairEntry, role: "device" | "mobile"): string {
    const nonce = randomBytes(16).toString("base64url");
    entry.nonce = { value: nonce, role, expiresAt: Date.now() + NONCE_TTL_MS };
    return nonce;
  }

  /** 校验 proof = HMAC-SHA256(passHash, `${nonce}|${role}|${deviceSid}`)。 */
  verifyProof(entry: RelayPairEntry, role: "device" | "mobile", proof: string): boolean {
    const nonce = entry.nonce;
    if (!nonce || nonce.role !== role || nonce.expiresAt <= Date.now()) {
      return false;
    }
    entry.nonce = undefined;
    const expected = createHmac("sha256", entry.passHash)
      .update(`${nonce.value}|${role}|${entry.deviceSid}`)
      .digest("base64url");
    const a = Buffer.from(expected);
    const b = Buffer.from(proof);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  bindRole(entry: RelayPairEntry, role: "device" | "mobile", socket: WebSocket): void {
    const now = Date.now();
    entry.lastSeenAt = now;
    entry.refreshAt = now + this.options.pairTtlMs;
    if (role === "device") {
      const previous = entry.device;
      entry.device = socket;
      if (previous && previous !== socket) {
        this.closeQuietly(previous, 4002, "device-replaced");
      }
      return;
    }
    const previous = entry.mobile;
    entry.mobile = socket;
    if (previous && previous !== socket) {
      // 单页面互踢：先通知再关闭，让旧页面能映射 session-conflict。
      this.sendQuietly(previous, { type: "error", code: "KICKED", message: "kicked" });
      this.closeQuietly(previous, 4002, "kicked");
    }
    entry.pairStatus = "matched";
  }

  unbind(entry: RelayPairEntry, socket: WebSocket): "device" | "mobile" | null {
    if (entry.device === socket) {
      entry.device = undefined;
      return "device";
    }
    if (entry.mobile === socket) {
      entry.mobile = undefined;
      entry.pairStatus = "waiting";
      return "mobile";
    }
    return null;
  }

  lookup(deviceSid: string): RelayPairEntry | undefined {
    const entry = this.pairs.get(deviceSid);
    if (!entry) return undefined;
    if (entry.refreshAt <= Date.now()) {
      this.drop(entry);
      return undefined;
    }
    return entry;
  }

  /** data 帧转发：仅 matched 且对端在线时投递。 */
  forward(from: "device" | "mobile", entry: RelayPairEntry, payload: unknown): boolean {
    if (entry.pairStatus !== "matched") return false;
    const target = from === "device" ? entry.mobile : entry.device;
    if (!target || target.readyState !== target.OPEN) return false;
    const serialized = JSON.stringify({ type: "data", payload });
    if (Buffer.byteLength(serialized) > this.options.maxPhysicalFrameBytes) {
      this.options.logger.warn("relay: dropped oversize frame", {
        deviceSidSuffix: entry.deviceSid.slice(-6),
        bytes: Buffer.byteLength(serialized),
        maxBytes: this.options.maxPhysicalFrameBytes,
      });
      return false;
    }
    target.send(serialized);
    return true;
  }

  /** 心跳/查询：返回当前 pair_status。 */
  pairStatusOf(entry: RelayPairEntry): "waiting" | "matched" {
    return entry.pairStatus;
  }

  touch(entry: RelayPairEntry): void {
    entry.lastSeenAt = Date.now();
    entry.refreshAt = Date.now() + this.options.pairTtlMs;
  }

  drop(entry: RelayPairEntry): void {
    if (this.pairs.get(entry.deviceSid) === entry) {
      this.pairs.delete(entry.deviceSid);
    }
    this.closeQuietly(entry.device, 4003, "pair-expired");
    this.closeQuietly(entry.mobile, 4003, "pair-expired");
    entry.device = undefined;
    entry.mobile = undefined;
    this.options.logger.info("relay: pair dropped", {
      deviceSidSuffix: entry.deviceSid.slice(-6),
    });
  }

  sweepExpired(): void {
    const now = Date.now();
    for (const entry of this.pairs.values()) {
      if (entry.refreshAt > now) continue;
      this.drop(entry);
    }
  }

  heartbeatHintMs(): number {
    return HEARTBEAT_HINT_MS;
  }

  /** passHash = SHA-256(secret)；供运维侧核对配置使用，不参与运行时鉴权。 */
  static hashSecret(secret: string): string {
    return createHash("sha256").update(secret).digest("base64");
  }

  private sendQuietly(socket: WebSocket | undefined, frame: unknown): void {
    if (!socket || socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // 对端已断开：忽略
    }
  }

  private closeQuietly(socket: WebSocket | undefined, code: number, reason: string): void {
    if (!socket) return;
    try {
      socket.close(code, reason);
    } catch {
      // 已关闭：忽略
    }
  }
}
