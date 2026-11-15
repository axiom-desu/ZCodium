export const extensionHostProtocolModule = {
  id: "extension-host-protocol",
  // sessions 能力表直接引用 session-control 的 App 端口 schema；不复制 DTO。
  requires: ["shared", "session-control"],
  provides: ["extension-host-protocol"],
  publicEntrypoints: ["index.ts", "contract.ts", "adapters/sdk.ts"],
} as const;
