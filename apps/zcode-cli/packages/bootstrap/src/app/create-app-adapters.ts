import type { ConfigResult } from "@zcode/adapters/config";
import { join } from "node:path";
import { createNodeToolArtifactStore } from "@zcode/adapters/storage";
import { createNodeLoggerFactory } from "@zcode/adapters/logging";
import { resolvePath } from "@zcode/adapters/config";
import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createNodeWebFetchHttpClientAdapter } from "@zcode/adapters/http";
import { createJimpImageProcessorAdapter } from "@zcode/adapters/image";
import { createPopplerPdfDocumentAdapter } from "@zcode/adapters/pdf";
import { createNodeSessionMailboxAdapter } from "@zcode/adapters/mailbox";
import { createMcpAdapter } from "@zcode/adapters/mcp";

import type { ZCodeAppOptions } from "./types.js";
import { isMessageEnabled } from "./app-config-options.js";
import { asInputHistoryStore } from "./session-store.js";

interface AppAdapterPortsInput {
  appVersion: string;
  configResult: ConfigResult;
  logger: ReturnType<ReturnType<typeof createNodeLoggerFactory>["createLogger"]>;
  options: ZCodeAppOptions;
  runtimeConfig: import("@zcode/core").AgentRuntimeConfig;
  sessionStore: import("@zcode/contracts").SessionStorePort;
  storageRoot: string;
  workingDirectory: string;
}

export function createAppAdapterPorts(
  input: AppAdapterPortsInput,
  afterSessionMailbox: () => void,
) {
  const {
    appVersion,
    configResult,
    logger,
    options,
    runtimeConfig,
    sessionStore,
    storageRoot,
    workingDirectory,
  } = input;
  const inputHistoryStore = options.inputHistoryStore ?? asInputHistoryStore(sessionStore);
  const artifactStore =
    options.artifactStore ??
    createNodeToolArtifactStore({
      imageCacheRootDir: join(storageRoot, "cli", "image-cache"),
      pdfCacheRootDir: join(storageRoot, "cli", "pdf-cache"),
      rootDir: join(storageRoot, "cli", "artifacts"),
      videoCacheRootDir: join(storageRoot, "cli", "video-cache"),
    });
  const imageProcessorPort = options.imageProcessorPort ?? createJimpImageProcessorAdapter();
  const messageEnabled = isMessageEnabled(options.env ?? process.env);
  const sessionMailboxPort =
    options.sessionMailboxPort ??
    (messageEnabled
      ? createNodeSessionMailboxAdapter({
          rootDir: resolvePath(
            (options.env ?? process.env).ZCODE_MAILBOX_ROOT ?? "~/.zcodium/mailbox",
          ),
        })
      : undefined);
  afterSessionMailbox();
  const mcpPort =
    options.mcpPort ??
    (runtimeConfig.mcp?.enabled === false
      ? undefined
      : (options.mcpPortFactory?.({ workingDirectory }) ??
        createMcpAdapter({
          clientVersion: appVersion,
          env: options.env,
          logger,
          network: {
            httpProxy: configResult.config.network.httpProxy,
            noProxy: configResult.config.network.noProxy,
            caCertFile: configResult.config.network.caCertFile,
          },
          workingDirectory,
        })));
  const ownsMcpPort = options.mcpPort === undefined && mcpPort !== undefined;
  const executionPort =
    options.executionPort ??
    createNodeExecutionAdapter({
      onToolExecResource: options.onToolExecResource,
      network: {
        httpProxy: configResult.config.network.httpProxy,
        noProxy: configResult.config.network.noProxy,
        caCertFile: configResult.config.network.caCertFile,
      },
      outputRootDir: join(storageRoot, "cli", "exec"),
      processEnv: options.env ?? process.env,
    });
  const ownsExecutionPort = options.executionPort === undefined;
  const pdfDocumentPort =
    options.pdfDocumentPort ?? createPopplerPdfDocumentAdapter({ executionPort });
  // browser-use 控制端口：仅当宿主（desktop）注入时可用，无本地 fallback（纯 CLI 无浏览器底座）。
  const fileSystemPort = options.fileSystemPort ?? createNodeFileSystemAdapter();
  const httpClientPort =
    options.httpClientPort ??
    createNodeWebFetchHttpClientAdapter({
      env: options.env ?? process.env,
      timeoutMs: configResult.config.network.timeout,
      proxyUrl: configResult.config.network.httpProxy,
      noProxy: configResult.config.network.noProxy,
      caCertFile: configResult.config.network.caCertFile,
    });

  return {
    artifactStore,
    executionPort,
    fileSystemPort,
    httpClientPort,
    imageProcessorPort,
    inputHistoryStore,
    mcpPort,
    ownsExecutionPort,
    ownsMcpPort,
    pdfDocumentPort,
    sessionMailboxPort,
  };
}
