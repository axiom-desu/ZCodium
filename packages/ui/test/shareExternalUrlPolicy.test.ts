import { describe, expect, it } from "vitest";

import { isPrivateOrLocalHostname } from "@/lib/shareExternalUrlPolicy.js";

/** 用 URL 解析结果做断言，确认真实跳转上下文拿到的 hostname 已被规范化。 */
function hostnameOf(href: string): string {
  return new URL(href).hostname;
}

describe("share external url host policy", () => {
  it("blocks loopback, private, link-local and ULA hosts", () => {
    for (const href of [
      "http://localhost/x",
      "http://localhost./x",
      "http://app.localhost/x",
      "http://127.0.0.1/x",
      "http://0.0.0.0/x",
      "http://10.1.2.3/x",
      "http://172.16.0.1/x",
      "http://192.168.1.1/x",
      "http://169.254.169.254/x",
      "http://100.64.0.1/x",
      "http://[::1]/x",
      "http://[::]/x",
      "http://[fc00::1]/x",
      "http://[fd12:3456::1]/x",
      "http://[fe80::1]/x",
    ]) {
      expect(isPrivateOrLocalHostname(hostnameOf(href)), href).toBe(true);
    }
  });

  it("blocks IPv6-mapped and encoded IPv4 forms after URL normalization", () => {
    for (const href of [
      "http://[::ffff:127.0.0.1]/x",
      "http://[::ffff:7f00:1]/x",
      "http://[::ffff:192.168.1.1]/x",
      "http://2130706433/x",
      "http://0x7f000001/x",
      "http://0x7f.1/x",
      "http://127.1/x",
      "http://%31%32%37.0.0.1/x",
    ]) {
      expect(isPrivateOrLocalHostname(hostnameOf(href)), href).toBe(true);
    }
  });

  it("keeps public hosts open", () => {
    for (const href of [
      "https://example.com/x",
      "https://share.zcode.example/x",
      "http://8.8.8.8/x",
      "http://172.32.0.1/x",
      "http://[2606:4700:4700::1111]/x",
    ]) {
      expect(isPrivateOrLocalHostname(hostnameOf(href)), href).toBe(false);
    }
  });
});
