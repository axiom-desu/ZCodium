import type { ZCodeApp, ZCodeAppOptions } from "./types.js";
import { resolveAppDependencies } from "./create-app-dependencies.js";
import { resolveAppStartupIdentity } from "./create-app-startup-identity.js";
import { createAppRuntime } from "./create-app-runtime.js";
import { createAppSurface } from "./create-app-app-surface.js";
import {
  attachStandaloneSessionControl,
  resolveAppSessionControl,
} from "./create-app-session-control.js";
import { resolveAppPluginDiscoveryPort } from "./create-app-plugin-discovery.js";

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
    // 独立 CLI 主根在这里拿到自己的会话控制绑定；子根由同一个 manager 的 createRootApp 传绑定进来。
    const standalone = await resolveAppSessionControl(options, {
      sessionId: identity.sessionId,
      workingDirectory: identity.workingDirectory,
      sessionStore: deps.sessionStore,
      // 会话控制读取要与协议读取用同一份 rewind 账本，否则旧分支会从工具结果复活。
      ...(options.eventStore ? { eventStore: options.eventStore } : {}),
    });
    // 插件发现端口由本进程既有插件 store 提供；Host 显式注入时只做透传。
    const pluginDiscoveryPort = resolveAppPluginDiscoveryPort(options, deps, {
      workingDirectory: identity.workingDirectory,
    });
    const appOptions: ZCodeAppOptions = {
      ...options,
      pluginDiscoveryPort,
      ...(standalone ? { sessionControl: standalone.binding } : {}),
    };
    runtimeBundle = createAppRuntime(appOptions, deps);
    const app = createAppSurface(appOptions, deps, runtimeBundle);
    return standalone ? attachStandaloneSessionControl(app, standalone) : app;
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
