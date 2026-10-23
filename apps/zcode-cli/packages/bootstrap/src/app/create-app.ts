import type { ZCodeApp, ZCodeAppOptions } from "./types.js";
import { resolveAppDependencies } from "./create-app-dependencies.js";
import { resolveAppStartupIdentity } from "./create-app-startup-identity.js";
import { createAppRuntime } from "./create-app-runtime.js";
import { createAppSurface } from "./create-app-app-surface.js";

export async function createZCodeApp(options: ZCodeAppOptions): Promise<ZCodeApp> {
  if (!options?.providerRegistry) {
    throw new Error("createZCodeApp requires a Provider Registry");
  }
  const identity = resolveAppStartupIdentity(options);
  let deps: Awaited<ReturnType<typeof resolveAppDependencies>> | undefined;
  let runtimeBundle: ReturnType<typeof createAppRuntime> | undefined;
  try {
    // 依赖构造 → runtime 装配 → 公开 API 面，严格保持原 async IO 顺序。
    deps = await resolveAppDependencies(options, identity);
    runtimeBundle = createAppRuntime(options, deps);
    return createAppSurface(options, deps, runtimeBundle);
  } catch (error) {
    runtimeBundle?.providerModelRuntime?.dispose();
    void deps?.ownedNodeReplBrowserBroker?.close();
    deps?.startupTimer.fail("ZCode app startup failed", error, {
      context: { sessionId: identity.sessionId, workingDirectory: identity.workingDirectory },
      event: "bootstrap.app.startup.failed",
      stage: "total",
    });
    throw error;
  }
}
