/**
 * 分享正文外链的宿主策略。
 *
 * 这是「展示/导航」风险，不是 SSRF：跳转发生在读者浏览器里，服务端不会因此获得内网访问能力。
 * 公开正文是不可信输入，读者又常在分享页旁边开着本地服务，所以只拦可点击外链跳到本机/内网；
 * artifact URL 是公开契约校验后的资源，仍按约定宿主读取（匿名落地页测试与自建部署都用 loopback），
 * 不能套用同一条规则误杀。唯一的实现放在这里，避免再长出一条字符串启发式分支。
 *
 * `new URL()` 已经会把十进制/十六进制/百分号编码的 IPv4 和 IPv6 映射地址规范化，
 * 因此这里只对规范化后的 hostname 做解析，不重复解析原始文本。
 */

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => (/^\d{1,3}$/u.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second] = octets as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isPrivateIpv6(host: string): boolean {
  // 通配与回环。
  if (host === "::" || host === "::1") return true;
  // IPv4 映射地址：URL 会把 [::ffff:127.0.0.1] 规范化成 [::ffff:7f00:1]。
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(host);
  if (mapped) {
    const high = Number.parseInt(mapped[1]!, 16);
    const low = Number.parseInt(mapped[2]!, 16);
    return isPrivateIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff].join("."));
  }
  const firstGroup = /^([0-9a-f]{1,4}):/u.exec(host)?.[1];
  if (!firstGroup) return false;
  const value = Number.parseInt(firstGroup, 16);
  // fc00::/7 唯一本地地址，fe80::/10 链路本地。
  return (value & 0xfe00) === 0xfc00 || (value & 0xffc0) === 0xfe80;
}

export function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return host.includes(":") ? isPrivateIpv6(host) : isPrivateIpv4(host);
}
