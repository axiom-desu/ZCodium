import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

// Entrypoints have process/DOM side effects; supplement real factory tests with wiring guards.
it.each([
  [
    "packages/desktop/src/host/index.ts",
    "logger: (message, ...args) => logger.warn(message, ...args)",
  ],
  [
    "packages/desktop/src/host/serverRemoteConnection.ts",
    "rpcLog.warn(undefined, message, ...args)",
  ],
  ["packages/server/src/remote/connect.ts", "logger: log"],
  ["packages/server/src/http.ts", "logger: log"],
  ["packages/server/src/stdio.ts", "rpcLog.warn(undefined, message, ...args)"],
  ["packages/zcode-server-cli/src/server-core/http.ts", "log.warn(undefined, message, ...args)"],
  [
    "packages/services/src/bots/botRemoteRuntimeServices.ts",
    "rpcLog.warn(undefined, message, ...args)",
  ],
  ["packages/desktop/src/renderer/src/main.tsx", "logger: logger.lifecycle.warn"],
  ["packages/web/src/main.tsx", "logger: logger.lifecycle.warn"],
  ["packages/web/src/mobile/protocol.ts", "logger: logger.lifecycle.warn"],
])("%s retains a host diagnostic sink", async (path, wiring) => {
  expect(await readFile(path, "utf8")).toContain(wiring);
});
