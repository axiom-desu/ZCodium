import { createRootTraceContext, createSessionId } from "@zcode/contracts";
import { resolve } from "node:path";
import { startupNow } from "../startup-logging.js";
import type { ZCodeAppOptions } from "./types.js";

export interface AppStartupIdentity {
  appVersion: string;
  sessionId: import("@zcode/contracts").SessionId;
  startupStartedAt: number;
  traceContext: import("@zcode/contracts").TraceContext;
  workingDirectory: string;
}

export function resolveAppStartupIdentity(options: ZCodeAppOptions): AppStartupIdentity {
  const sessionId = options.sessionId ?? createSessionId();
  return {
    appVersion: options.version ?? "0.0.0",
    sessionId,
    startupStartedAt: startupNow(),
    traceContext: options.traceContext ?? createRootTraceContext({ sessionId }),
    workingDirectory: resolve(options.runtimeConfig?.workingDirectory ?? process.cwd()),
  };
}
