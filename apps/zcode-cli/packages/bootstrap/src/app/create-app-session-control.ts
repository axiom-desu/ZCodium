import type { SessionStorePort } from "@zcode/contracts";
import type { SessionControlBinding } from "@zcode/core";
import { createZCodeApp } from "./create-app.js";
import { createCliSessionControlBinding, createCliSessionControlRuntime } from "../cli-session-control/index.js";
import type { CliSessionControlRuntime } from "../cli-session-control/contract.js";
import type { ZCodeApp, ZCodeAppOptions } from "./types.js";

interface StandaloneSessionControl {
  binding: SessionControlBinding;
  runtime: CliSessionControlRuntime;
  /** 来源来自可信启动选项；只决定是否可写，不决定是否关闭。 */
  provenance: "new-independent-root" | "unverified-history";
}

/**
 * 独立 CLI 的会话控制装配。
 *
 * 只有显式 `standaloneSessionControl: true` 的启动方（CLI/TUI 主根）才启用：桌面与远程 Host
 * 会话不写该标志，因此它们没有第二个会话控制面。子根（create/fork 出来的会话）复用同一个
 * manager，并获得指向自己的绑定——执行仍然走各自的 Core runtime。
 */
export async function resolveAppSessionControl(
  options: ZCodeAppOptions,
  input: {
    sessionId: string;
    workingDirectory: string;
    sessionStore: SessionStorePort;
    eventStore?: import("@zcode/contracts").SessionEventStorePort;
  },
): Promise<StandaloneSessionControl | undefined> {
  if (options.standaloneSessionControl !== true) return undefined;
  if (
    options.sessionControl ||
    options.runtimeConfig?.parentSessionId ||
    options.runtimeConfig?.workspaceIdentity
  ) {
    throw new Error("Standalone session control requires an independent local CLI root");
  }
  // resume 或复用历史 ID 不证明独立来源，不能因当前进程拿到 runtime 就把历史升级为可写目标。
  const persisted = await input.sessionStore.getSession(input.sessionId as never);
  const provenance =
    options.resume !== true && !persisted ? "new-independent-root" : "unverified-history";
  const workspace = { kind: "cli" as const, workspacePath: input.workingDirectory };
  const runtime = createCliSessionControlRuntime({
    workspace,
    sessionStore: input.sessionStore,
    ...(input.eventStore ? { eventStore: input.eventStore } : {}),
    createRootApp: async (request) =>
      // 新根只借用基础设施和独立 CLI 配置，不展开 actor 的 runtimeConfig、yolo 或审批结果。
      createZCodeApp({
        sessionId: request.sessionId,
        resume: request.resume,
        traceContext: request.traceContext,
        sessionStore: input.sessionStore,
        sessionControl: createCliSessionControlBinding(runtime.control, {
          sessionId: request.sessionId,
          workspace,
        }),
        // 共享启动方的询问通道（TUI 审批队列 / headless 拒绝），只共用通道，不共用批准结果。
        permissionBroker: options.permissionBroker,
        providerRegistry: options.providerRegistry,
        configuredDefaultModelSelection: options.configuredDefaultModelSelection,
        modelAdapter: options.modelAdapter,
        executionPort: options.executionPort,
        fileSystemPort: options.fileSystemPort,
        httpClientPort: options.httpClientPort,
        env: options.env,
        skipUserConfig: options.skipUserConfig,
        userConfigPath: options.userConfigPath,
        version: options.version,
        runtimeConfig: {
          workingDirectory: request.cwd,
          taskType: request.resume ? "fork" : "interactive",
          mode: "build",
        },
      }),
  });
  return {
    binding: createCliSessionControlBinding(runtime.control, {
      sessionId: input.sessionId,
      workspace,
    }),
    runtime,
    provenance,
  };
}

/**
 * 把主根挂进 manager（借用：关闭责任仍在调用方），并把 manager 的收尾接到既有 `close()`。
 * 包装只增加一步：先关闭 App 自有资源，再等 manager 的未决 mutation 结算。
 */
export function attachStandaloneSessionControl(
  app: ZCodeApp,
  control: StandaloneSessionControl,
): ZCodeApp {
  control.runtime.attachRoot(app, control.provenance);
  const close = app.close?.bind(app);
  app.close = async () => {
    const results = await Promise.allSettled([close?.(), control.runtime.close()]);
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "CLI session control close failed");
  };
  return app;
}
