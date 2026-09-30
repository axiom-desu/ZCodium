import { createHash, createHmac, randomBytes } from "node:crypto";

/**
 * relay 鉴权提供者（与官方 3.14.3 恢复结果对齐）：
 * - password: 24 随机字节 base64url，只在配对链接里出现一次；
 * - passHash: SHA-256(password) base64，落 credential store；
 * - proof: HMAC-SHA256(passHash, `${nonce}|${role}|${deviceSid}`) base64url。
 */

export interface WebRemoteControlRelayAuthProvider {
  createPassword(): string;
  createPassHash(password: string): string;
  calculateProof(passHash: string, nonce: string, role: string, deviceSid: string): string;
}

export function createNodeWebRemoteControlRelayAuthProvider(): WebRemoteControlRelayAuthProvider {
  return {
    createPassword: () => randomBytes(24).toString("base64url"),
    createPassHash: (password) => createHash("sha256").update(password).digest("base64"),
    calculateProof: (passHash, nonce, role, deviceSid) =>
      createHmac("sha256", passHash).update(`${nonce}|${role}|${deviceSid}`).digest("base64url"),
  };
}
