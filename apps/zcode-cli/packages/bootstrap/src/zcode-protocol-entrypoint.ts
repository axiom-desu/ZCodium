import { createConfig } from "@zcode/adapters/config";
import type { McpElicitationPort, McpNotificationPort } from "@zcode/contracts";
import { createNodeModelSelectionFacade } from "@zcode/provider-node";
import { createNodeLoggerFactory } from "@zcode/adapters/logging";
import {
  createMcpAdapterConnectionPool,
  createMcpProcessTracker,
  type McpConnectionPool,
  type McpProcessTracker,
} from "@zcode/adapters/mcp";
import {
  zcodeProtocolNotifications,
  type ZCodeMcpResourceSample,
  type ZCodeMcpTelemetryEvent,
} from "@zcode/shared";
import type { SqliteSessionStore } from "@zcode/adapters/storage";
import { traceContextToLogContext, createRootTraceContext } from "@zcode/contracts";
import type { McpPort, ModelSelection } from "@zcode/contracts";
import type { PresentationSurface } from "@zcode/core";
import type { RunZCodeProtocolAgentOptions, ZCodeAppOptions } from "./app/types.js";
import { createZCodeApp } from "./app/create-app.js";
import {
  createNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "./app/node-repl-browser-broker.js";
import {
  openProtocolStartupStorage,
  prepareProtocolStartupStorage,
} from "./zcode-protocol/storage-startup.js";
import { closeSessionStore, getSessionDbPath } from "./app/session-store.js";
import { startProcessProviderRegistryRuntime } from "./app/process-provider-registry-runtime.js";
import { scheduleStartupLogRetentionCleanup } from "./log-retention.js";
import { StartupTimer, startupNow } from "./startup-logging.js";
import { installZCodeProtocolAiSdkWarningLogger } from "./zcode-protocol/ai-sdk-warning-logger.js";
import { ZCodeProtocolAgentServer } from "./zcode-protocol/server.js";
import { ZCodeProtocolNdjsonConnection } from "./zcode-protocol/transport.js";
import { cleanupProtocolRuntime } from "./zcode-protocol/runtime-cleanup.js";
import {
  startProtocolMaintenance,
  type ProtocolMaintenance,
} from "./zcode-protocol/maintenance.js";
import { acquireProtocolStartupResource } from "./zcode-protocol/startup-resource.js";

function applyProtocolPresentationSurface(
  options: Omit<ZCodeAppOptions, "providerRegistry">,
  presentationSurface: PresentationSurface,
): Omit<ZCodeAppOptions, "providerRegistry"> {
  return {
    ...options,
    runtimeConfig: {
      ...options.runtimeConfig,
      presentationSurface,
    },
  };
}

/**
 * 进程级 Registry 已就绪后，它就是当前 Environment 的模型事实源。
 *
 * 旧 workspace snapshot 不再参与 Provider 和 Model 执行。
 */
function applyProtocolProviderRegistry(
  options: Omit<ZCodeAppOptions, "providerRegistry">,
  providerRegistry: ZCodeAppOptions["providerRegistry"],
  configuredDefaultModelSelection?: ModelSelection,
): ZCodeAppOptions {
  return {
    ...options,
    providerRegistry,
    ...(configuredDefaultModelSelection ? { configuredDefaultModelSelection } : {}),
  };
}

export async function runZCodeProtocolAgent(
  options: RunZCodeProtocolAgentOptions = {},
): Promise<void> {
  if (options.prepareStorageOnly) {
    const config = createConfig({ env: options.env });
    await prepareProtocolStartupStorage({
      dbPath: getSessionDbPath(config, options.cwd),
      input: options.input ?? process.stdin,
      output: options.output ?? process.stdout,
    });
    return;
  }
  const startupStartedAt = startupNow();
  const presentationSurface = options.presentationSurface ?? "terminal";
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  let diagnosticSink: ((record: import("@zcode/shared").DiagnosticRecord) => void) | undefined;
  const loggerFactory = createNodeLoggerFactory({
    env: options.env,
    onDiagnostic: (record) => diagnosticSink?.(record),
  });
  const traceContext = createRootTraceContext({
    attributes: {
      entrypoint: "zcode_protocol",
    },
  });
  const logger = loggerFactory.createLogger("zcode").child({
    ...traceContextToLogContext(traceContext),
    module: "bootstrap.zcode_protocol",
  });
  installZCodeProtocolAiSdkWarningLogger(logger);
  const startupTimer = new StartupTimer(
    logger,
    {
      ...traceContextToLogContext(traceContext),
      module: "bootstrap.zcode_protocol",
      startupKind: "zcode_protocol_agent",
    },
    startupStartedAt,
  );
  startupTimer.start("ZCode Protocol agent startup started", {
    context: { version: options.version },
    event: "zcode_protocol.startup.started",
    stage: "start",
  });

  let sessionStore: SqliteSessionStore | undefined;
  let serverForCleanup: ZCodeProtocolAgentServer | undefined;
  let nodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  let mcpConnectionPool: McpConnectionPool | undefined;
  let mcpPort: McpPort | undefined;
  let mcpProcessesTracker: McpProcessTracker | undefined;
  let mcpResourceSink: ((samples: ZCodeMcpResourceSample[]) => void) | undefined;
  let mcpDiagnosticSink: ((event: ZCodeMcpTelemetryEvent) => void) | undefined;
  let protocolMaintenance: ProtocolMaintenance | undefined;
  let providerRegistryRuntime:
    | Awaited<ReturnType<typeof startProcessProviderRegistryRuntime>>
    | undefined;
  try {
    // 数据库准备先于账号、Registry 和遥测，不把远端材料等待混进迁移门禁。
    const configResult = createConfig({ env: options.env });
    sessionStore = await acquireProtocolStartupResource({
      signal: options.lifecycle?.signal,
      logger,
      disposeLate: (store) => closeSessionStore(store),
      create: () =>
        openProtocolStartupStorage({
          dbPath: getSessionDbPath(configResult),
          output,
          onProgress: (progress) =>
            logger.info("SQLite startup state", {
              event: "zcode_protocol.startup.storage_state",
              ...progress,
            }),
        }),
    });
    const runtimeEnv = options.env ?? process.env;
    options.lifecycle?.signal.throwIfAborted();
    providerRegistryRuntime = await acquireProtocolStartupResource({
      signal: options.lifecycle?.signal,
      logger,
      create: () => startProcessProviderRegistryRuntime(runtimeEnv),
      disposeLate: (runtime) => runtime.dispose(),
    });
    options.lifecycle?.signal.throwIfAborted();
    logger.info("Worker Provider Registry 已就绪", {
      accountRevision: providerRegistryRuntime.snapshot.sourceRevisions.account,
      configRevision: providerRegistryRuntime.snapshot.sourceRevisions.config,
      event: "zcode_protocol.provider_registry.ready",
      module: "bootstrap.zcode_protocol",
      providerCount: providerRegistryRuntime.snapshot.registry.providers.length,
    });
    mcpProcessesTracker =
      configResult.config.features.mcp === false
        ? undefined
        : createMcpProcessTracker({
            onEvent: (event) => mcpDiagnosticSink?.(event),
            onResourceSamples: (samples) => mcpResourceSink?.(samples),
          });
    // MCP elicitation 归属到协议 server 的会话；pool 先于 server 创建，端口延迟绑定。
    let elicitationServer: {
      requestMcpElicitation: McpElicitationPort["requestElicitation"];
      handleMcpNotification: McpNotificationPort["onNotification"];
    } | null = null;
    mcpConnectionPool =
      configResult.config.features.mcp === false
        ? undefined
        : createMcpAdapterConnectionPool({
            elicitation: {
              requestElicitation: (request, elicitationOptions) =>
                elicitationServer
                  ? elicitationServer.requestMcpElicitation(request, elicitationOptions)
                  : Promise.resolve({ action: "decline" as const }),
            },
            // server 通知同样延迟绑定到协议 server。
            notifications: {
              onNotification: (notification) => elicitationServer?.handleMcpNotification(notification),
            },
            clientVersion: options.version ?? "0.0.0",
            env: options.env,
            logger,
            network: {
              httpProxy: configResult.config.network.httpProxy,
              noProxy: configResult.config.network.noProxy,
              caCertFile: configResult.config.network.caCertFile,
            },
            processTracker: mcpProcessesTracker,

            workingDirectory: options.cwd,
          });
    mcpPort = mcpConnectionPool?.acquireLease({ leaseId: "protocol-settings" });
    const activeProviderRegistryRuntime = providerRegistryRuntime;
    const modelSelectionFacade = createNodeModelSelectionFacade(
      activeProviderRegistryRuntime.runtime.registryService,
    );
    options.lifecycle?.signal.throwIfAborted();
    const server = (serverForCleanup = new ZCodeProtocolAgentServer({
      createZCodeApp: (appOptions = {}) =>
        createZCodeApp({
          ...applyProtocolProviderRegistry(
            applyProtocolPresentationSurface(appOptions, presentationSurface),
            activeProviderRegistryRuntime.runtime.registryService,
            activeProviderRegistryRuntime.configuredDefaultModelSelection,
          ),
          // 只读同进程已应用快照；不为子任务另发 Host RPC，也不在 ModelFactory 偷换模型。
          resolveEffectiveModelSelection: (selection) => {
            const view = modelSelectionFacade.getView(undefined, undefined, { selection });
            return {
              effectiveSelection: view.effectiveSelection ?? null,
              selectionIssue: view.selectionIssue,
            };
          },
          env: {
            ...runtimeEnv,
            ...appOptions.env,
          },
          ...(nodeReplBrowserBroker ? { nodeReplBrowserBroker } : {}),
          ...(mcpConnectionPool
            ? {
                mcpPortFactory: () =>
                  mcpConnectionPool!.acquireLease({
                    leaseId: appOptions.sessionId,
                    sessionId: appOptions.sessionId,
                  }),
              }
            : {}),
          onToolExecResource: (params) =>
            connection.send({ method: zcodeProtocolNotifications.toolExecResource, params }),
        }),
      cwd: options.cwd,
      env: options.env,
      loggerFactory,
      mcpPort,
      mcpProcesses: mcpProcessesTracker,
      sessionStore,
      refreshProviderRegistry: async (reason) => {
        await activeProviderRegistryRuntime.runtime.registryService.refresh(reason);
      },
      version: options.version,
    }));
    elicitationServer = server;
    if (configResult.config.features.mcp !== false) {
      nodeReplBrowserBroker = createNodeReplBrowserBroker({
        browserControlPort: server.browserControlPort,
        logger,
        platform: process.platform,
      });
      const broker = nodeReplBrowserBroker;
      await acquireProtocolStartupResource({
        signal: options.lifecycle?.signal,
        logger,
        create: () => broker.ready,
      });
    }
    const connection = new ZCodeProtocolNdjsonConnection({
      signal: options.lifecycle?.signal,
      clearPostResponseMessages: () => server.clearPostResponseMessages(),
      handleMessage: (message) => server.handleMessage(message),
      input,
      logger,
      onTransportClosed: (error) => server.disconnectClient(error),
      output,
      takePostResponseBatch: (requestId) => server.takePostResponseBatch(requestId),
    });
    server.setNotificationSink((notification) => connection.send(notification));
    mcpResourceSink = (params) =>
      connection.send({ method: zcodeProtocolNotifications.mcpResourceSamples, params });
    mcpDiagnosticSink = (params) =>
      connection.send({ method: zcodeProtocolNotifications.mcpTelemetry, params });
    diagnosticSink = (params) =>
      connection.send({ method: zcodeProtocolNotifications.diagnostic, params });
    connection.start();
    mcpProcessesTracker?.start();
    protocolMaintenance = startProtocolMaintenance(server, logger, (message) =>
      connection.send(message),
    );
    startupTimer.complete("ZCode Protocol agent startup completed", {
      event: "zcode_protocol.startup.completed",
      stage: "total",
    });
    scheduleStartupLogRetentionCleanup(loggerFactory, logger);
    await connection.waitForClose();
  } catch (error) {
    options.lifecycle?.requestShutdown(
      error instanceof Error ? error : new Error("Protocol runtime failed", { cause: error }),
    );
    startupTimer.fail("ZCode Protocol agent startup failed", error, {
      event: "zcode_protocol.startup.failed",
      stage: "total",
    });
    throw error;
  } finally {
    options.lifecycle?.requestShutdown();
    await cleanupProtocolRuntime({
      logger,
      deadlineAt: options.lifecycle?.deadlineAt,
      server: serverForCleanup,
      protocolMaintenance,
      mcpProcessesTracker,
      nodeReplBrowserBroker,
      mcpPort,
      mcpConnectionPool,
      sessionStore,
      providerRegistryRuntime,
    });
    logger.info("ZCode Protocol agent shutdown completed", {
      ...traceContextToLogContext(traceContext),
      event: "zcode_protocol.shutdown.completed",
      module: "bootstrap.zcode_protocol",
      status: "completed",
    });
    await loggerFactory.flush();
    diagnosticSink = undefined;
  }
}
