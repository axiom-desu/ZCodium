/* eslint-disable max-lines -- Source Server transport 在同一适配器内汇合安装、daemon、channel 与 target 生命周期，继续拆分会割裂取消边界。 */
import { Duplex } from "node:stream";
import {
  isPublicZCodeErrorCode,
  normalizeRemoteConnectionError,
  sourceServerInstallProgressSchema,
  type PublicZCodeErrorCode,
  type RemoteTarget,
} from "@zcode/shared";
import type { IRemoteBackend } from "@zcode/server/remote/backend.js";
import { createRemoteBackend } from "@zcode/server/remote/create-backend.js";
import { detectRemoteAssetTools } from "@zcode/server/remote/remoteAssetPreflight.js";
import {
  probeSourceServer,
  SourceServerProbeEnvironmentError,
} from "@zcode/server/source-server/sourceServerProbe.js";
import {
  SOURCE_SERVER_DEFAULT_ROOT_READ_PATH,
  sourceServerBinShell,
  sourceServerRootShell,
  sourceServerRunFileReadPath,
} from "@zcode/server/source-server/sourceServerLayout.js";
import {
  collectCommand,
  duplexFromStdio,
  quoteShellArg,
  readLastJsonLine,
  readStructuredCommandError,
  throwIfAborted,
  type RemoteExecResult,
} from "@zcode/server/source-server/sourceServerTransportRuntime.js";

export type { RemoteExecResult } from "@zcode/server/source-server/sourceServerTransportRuntime.js";

export interface SourceServerProbeResult {
  platform: string;
  arch: string;
  installed: boolean;
  installPath?: string;
  installedVersion?: string;
  installedArchiveSha256?: string;
  daemonStatus?: Record<string, unknown> & { state: string; port?: number };
}

export interface SourceServerProbeOptions {
  includeReleaseIdentity?: boolean;
  /** 远端安装根（读取形态，可含 `~/`）；默认与 CLI 默认布局同源。 */
  rootReadPath?: string;
}

export interface SourceServerIngressInfo {
  port: number;
  ingressToken: string;
}

export interface ServerReleaseAsset {
  localArchivePath?: string;
  target: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  urls: string[];
}

export interface TransportContext {
  signal?: AbortSignal;
  onLog?: (event: {
    phase: string;
    message: string;
    progress?: number;
    level?: "info" | "warn" | "error";
  }) => void;
}

export interface SourceServerInstallOrUpdateOptions {
  force?: boolean;
}

export interface SourceServerEnsureDaemonOptions {
  observedStatus?: SourceServerProbeResult["daemonStatus"];
}

export class SourceServerTransportOperationError extends Error {
  public constructor(
    message: string,
    public readonly code: PublicZCodeErrorCode,
    public readonly retryable?: boolean,
  ) {
    super(message);
    this.name = "SourceServerTransportOperationError";
  }
}

export type SourceServerFileTransfer = Pick<IRemoteBackend, "exec" | "upload">;

/**
 * R3 transport 适配器合同（本片冻结）。
 *
 * 适配器只返回 Duplex / 命令结果 / 进度事件，不持有 profile、队列或快照状态；
 * 取消与资源回收只作用于它自己创建的 backend/tunnel。
 */
export interface SourceServerTransportAdapter {
  readonly kind: "ssh" | "wsl" | "docker";
  /** Host 附件暂存复用当前 target 的 transport，不创建另一条远程连接。 */
  createFileTransfer(target: RemoteTarget): SourceServerFileTransfer;
  /** 取消单个连接目标的底层 transport，防止超时 flight 迟到注册为在线 Source。 */
  cancel?(target: RemoteTarget): void;
  probe(
    target: RemoteTarget,
    context: TransportContext,
    options?: SourceServerProbeOptions,
  ): Promise<SourceServerProbeResult>;
  installOrUpdate(
    target: RemoteTarget,
    release: ServerReleaseAsset,
    context: TransportContext,
    options?: SourceServerInstallOrUpdateOptions,
  ): Promise<void>;
  ensureDaemon(
    target: RemoteTarget,
    context: TransportContext,
    options?: SourceServerEnsureDaemonOptions,
  ): Promise<SourceServerIngressInfo>;
  openChannel(
    target: RemoteTarget,
    ingress: SourceServerIngressInfo,
    context: TransportContext,
  ): Promise<Duplex>;
  exec(target: RemoteTarget, argv: string[], context: TransportContext): Promise<RemoteExecResult>;
  dispose?(): void;
}

export interface CreateSourceServerTransportAdapterOptions {
  createBackend?: (target: RemoteTarget) => Promise<IRemoteBackend>;
  /** 远端安装根（读取形态）；默认 `~/<数据根>/server`。 */
  rootReadPath?: string;
}

const STALE_BOOTSTRAP_AGE_MS = 30 * 60 * 1_000;
const INSTALL_PROGRESS_MESSAGES: Record<string, string> = {
  "verify-archive": "Verifying Source Server archive",
  extract: "Extracting Source Server files",
  verify: "Verifying Source Server files",
  restart: "Restarting Source Server",
};

class BackendSourceServerTransportAdapter implements SourceServerTransportAdapter {
  private readonly backends = new WeakMap<object, Promise<IRemoteBackend>>();
  private readonly backendPromises = new Set<Promise<IRemoteBackend>>();
  private readonly rootReadPath: string;

  public constructor(
    public readonly kind: "ssh" | "wsl" | "docker",
    private readonly createBackend: (target: RemoteTarget) => Promise<IRemoteBackend>,
    rootReadPath: string,
  ) {
    this.rootReadPath = rootReadPath;
  }

  public createFileTransfer(target: RemoteTarget): SourceServerFileTransfer {
    // 复用已有 backend 的文件原语，保证 desktop localPath 的跨机边界只有一条路径。
    const backend = this.getBackend(target);
    return {
      exec: async (command) => (await backend).exec(command),
      upload: async (localPath, remotePath, options) =>
        (await backend).upload(localPath, remotePath, options),
    };
  }

  public async probe(
    target: RemoteTarget,
    context: TransportContext,
    options: SourceServerProbeOptions = {},
  ): Promise<SourceServerProbeResult> {
    throwIfAborted(context.signal);
    const backend = await this.getBackend(target);
    try {
      return await probeSourceServer(backend, context, {
        ...options,
        rootReadPath: options.rootReadPath ?? this.rootReadPath,
      });
    } catch (error) {
      // Bug 原因：catch 对所有失败都套 preflight 阶段兜底，握手超时、握手前断开等未识别的
      // 传输失败被报成“设备环境不满足安装要求”。只有远端环境检查本身失败才是预检失败。
      const failure = normalizeRemoteConnectionError(
        error,
        error instanceof SourceServerProbeEnvironmentError ? "preflight" : undefined,
      );
      throw Object.assign(error instanceof Error ? error : new Error(failure.message), failure);
    }
  }

  public async installOrUpdate(
    target: RemoteTarget,
    release: ServerReleaseAsset,
    context: TransportContext,
    options: SourceServerInstallOrUpdateOptions = {},
  ): Promise<void> {
    let phase = "preflight";
    try {
      await this.installRelease(
        target,
        release,
        {
          ...context,
          onLog: (event) => {
            phase = event.phase;
            context.onLog?.(event);
          },
        },
        options,
      );
    } catch (error) {
      const failure = normalizeRemoteConnectionError(error, phase);
      throw Object.assign(error instanceof Error ? error : new Error(failure.message), failure);
    }
  }

  private async installRelease(
    target: RemoteTarget,
    release: ServerReleaseAsset,
    context: TransportContext,
    options: SourceServerInstallOrUpdateOptions,
  ): Promise<void> {
    throwIfAborted(context.signal);
    if (!release.localArchivePath) {
      // 本片只支持本地上传安装；远端直下需要 CDN 制品解析（下一片）。
      throw new Error("Source Server local archive is unavailable for upload");
    }
    const backend = await this.getBackend(target);
    const rootShell = sourceServerRootShell(this.rootReadPath);
    const operationId = `${process.pid}-${Date.now()}`;
    const bootstrapRootShell = `${rootShell}/.bootstrap-${operationId}`;
    const bootstrapDirShell = `${bootstrapRootShell}/extract`;
    const remoteArchive = `${bootstrapRootShell}/zcode-server.tar.gz`;
    const remoteArchiveShell = remoteArchive;
    const cleanupCommand = `rm -rf ${bootstrapRootShell}`;
    const cleanupStaleBootstrapRootsCommand =
      "now_ms=$(($(date +%s) * 1000)); " +
      `for candidate in ${rootShell}/.bootstrap-*; do ` +
      '[ -d "$candidate" ] || continue; ' +
      "name=${candidate##*/}; " +
      "created_ms=${name##*-}; " +
      'case "$created_ms" in ""|*[!0-9]*) continue ;; esac; ' +
      "age_ms=$((now_ms - created_ms)); " +
      `[ "$age_ms" -le ${STALE_BOOTSTRAP_AGE_MS} ] || rm -rf -- "$candidate"; ` +
      "done";
    const prepareBootstrapRoot = async (): Promise<void> => {
      const result = await collectCommand(
        await backend.exec(
          // Bug 原因：Controller 在上传中被强制退出时，JS catch 与远端 EXIT trap 都没有机会运行，
          // Server root 会永久积累半包。只回收带合法 epoch 后缀且超过 30 分钟的私有 staging。
          `${cleanupStaleBootstrapRootsCommand} && rm -rf ${bootstrapRootShell} && mkdir -p ${bootstrapRootShell}`,
        ),
      );
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || "Source Server bootstrap staging failed");
      }
    };

    context.onLog?.({
      phase: "preflight",
      message: "Checking remote installation prerequisites",
    });
    await detectRemoteAssetTools(backend, {
      log: (...args: unknown[]) =>
        context.onLog?.({ phase: "preflight", message: args.map(String).join(" ") }),
    });
    await prepareBootstrapRoot();
    context.onLog?.({
      phase: "upload",
      message: `Uploading Source Server ${release.version}`,
    });
    try {
      await backend.upload(release.localArchivePath, remoteArchive, {
        signal: context.signal,
        onProgress: ({ uploadedBytes, totalBytes }) =>
          context.onLog?.({
            phase: "upload",
            message: `upload progress: ${
              totalBytes > 0 ? ((uploadedBytes / totalBytes) * 100).toFixed(1) : "0.0"
            }% (${(uploadedBytes / 1048576).toFixed(1)}/${(totalBytes / 1048576).toFixed(1)} MB)`,
            progress: totalBytes > 0 ? uploadedBytes / totalBytes : 0,
          }),
      });
    } catch (error) {
      await collectCommand(await backend.exec(cleanupCommand)).catch(() => undefined);
      throw error;
    }

    context.onLog?.({ phase: "extract", message: INSTALL_PROGRESS_MESSAGES["extract"]! });
    const command = [
      "set -eu",
      // Bug 原因：running-task guard 让 update 非零退出后，`&& rm` 永远不会执行，远端 archive
      // 与 bootstrap staging 会持续残留。EXIT trap 覆盖成功、guard、解压失败和中断。
      `trap ${quoteShellArg(cleanupCommand)} EXIT`,
      `rm -rf ${bootstrapDirShell}`,
      `mkdir -p ${bootstrapDirShell}`,
      `tar -xzf ${remoteArchiveShell} -C ${bootstrapDirShell} --strip-components=1`,
      // Bug 原因：update 会重启完整 daemon；若不把既有 transport 能力边界传给目标 bootstrap CLI，
      // WSL/Docker 会在 handoff 时误尝试注册不可用的 systemd user service。
      `${this.kind === "ssh" ? "" : "ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1 "}${bootstrapDirShell}/bin/zcode update --from-archive ${remoteArchiveShell}${options.force ? " --force" : ""} --server-root ${rootShell} --json --progress`,
    ].join(" && ");
    // 上传完成后命令仍需解压、整树校验和 daemon 换代；必须实时消费阶段，不能等退出才显示。
    const result = await collectCommand(await backend.exec(command), (line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      const event = sourceServerInstallProgressSchema.safeParse(value);
      if (event.success) {
        context.onLog?.({
          phase: event.data.phase,
          message: INSTALL_PROGRESS_MESSAGES[event.data.phase] ?? event.data.phase,
        });
      }
    });
    if (result.exitCode !== 0) {
      const response = readLastJsonLine(result.stdout);
      if (isPublicZCodeErrorCode(response.code)) {
        throw new SourceServerTransportOperationError(
          typeof response.error === "string" && response.error.trim()
            ? response.error
            : "Source Server archive installation failed",
          response.code,
          typeof response.retryable === "boolean" ? response.retryable : undefined,
        );
      }
      // Bug 原因：CLI 的 --json 错误写在 stdout，stderr 可能只有 SQLite warning；
      // 安装路径与 daemon 启动复用同一错误解析，避免 warning 覆盖真正的失败原因。
      throw new Error(
        (readStructuredCommandError(result.stdout) ?? result.stderr.trim()) ||
          "Source Server archive installation failed",
      );
    }
    const response = readLastJsonLine(result.stdout);
    if (response.ok === false || response.applied !== true) {
      throw new Error("Source Server archive installation did not apply the release");
    }
    context.onLog?.({
      phase: "install",
      message: `Source Server ${release.version} installed`,
    });
  }

  public async ensureDaemon(
    target: RemoteTarget,
    context: TransportContext,
    options: SourceServerEnsureDaemonOptions = {},
  ): Promise<SourceServerIngressInfo> {
    throwIfAborted(context.signal);
    let status = options.observedStatus;
    const observedPort = Number(status?.port);
    const observedReady =
      status?.state === "ready" && Number.isInteger(observedPort) && observedPort > 0;
    if (!observedReady) {
      context.onLog?.({ phase: "daemon", message: "Starting Source Server" });
      const result = await this.exec(target, ["serve", "--daemon", "--json"], context);
      if (result.exitCode !== 0) {
        // Bug 原因：Server CLI 的 --json 错误写在 stdout，Node 运行时 warning 写在 stderr。
        // 旧逻辑只取 stderr，最终把 SQLite warning 当成连接根因展示给用户。
        throw new Error(
          (readStructuredCommandError(result.stdout) ?? result.stderr.trim()) ||
            "Source Server daemon failed to start",
        );
      }
      status = readLastJsonLine(result.stdout) as SourceServerProbeResult["daemonStatus"];
    }
    if (!status) throw new Error("Source Server daemon status is unavailable");
    const port = Number(status.port);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error("Source Server daemon did not report a valid ingress port");
    }
    if (status.serviceRegistered === false) {
      context.onLog?.({
        phase: "daemon",
        message: "Source Server started in detached fallback mode for this remote environment",
      });
    } else if (status.serviceRegistered === true) {
      context.onLog?.({
        phase: "daemon",
        message: "Source Server registered with the remote OS user service manager",
      });
    }
    const backend = await this.getBackend(target);
    const ingressToken = (
      await backend.readFile(sourceServerRunFileReadPath("ingress-token", this.rootReadPath))
    ).trim();
    if (!ingressToken) throw new Error("Source Server ingress token is missing");
    return { port, ingressToken };
  }

  public async openChannel(
    target: RemoteTarget,
    _ingress: SourceServerIngressInfo,
    context: TransportContext,
  ): Promise<Duplex> {
    throwIfAborted(context.signal);
    const backend = await this.getBackend(target);
    context.onLog?.({ phase: "channel", message: "Opening Source Server stdio channel" });
    // proxy-stdio 读取 daemon ready 端口并做纯字节桥；stdout 只含协议字节，诊断走 stderr。
    return duplexFromStdio(
      await backend.exec(
        `${sourceServerBinShell(this.rootReadPath)} server proxy-stdio --server-root ${sourceServerRootShell(this.rootReadPath)}`,
      ),
    );
  }

  public async exec(
    target: RemoteTarget,
    argv: string[],
    context: TransportContext,
  ): Promise<RemoteExecResult> {
    throwIfAborted(context.signal);
    const backend = await this.getBackend(target);
    const hasServerRoot = argv.includes("--server-root");
    const daemonEnvironment =
      this.kind !== "ssh" && argv[0] === "serve" && argv.includes("--daemon")
        ? "ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1 "
        : "";
    const command = [
      // Bug 原因：WSL/Docker 没有稳定的用户级服务管理器；若沿用 SSH 命令会尝试注册
      // systemd user service 并在常见环境中失败。两者必须显式进入 detached fallback。
      `${daemonEnvironment}${sourceServerBinShell(this.rootReadPath)}`,
      ...argv.map(quoteShellArg),
      ...(hasServerRoot ? [] : ["--server-root", sourceServerRootShell(this.rootReadPath)]),
    ].join(" ");
    return await collectCommand(await backend.exec(command));
  }

  public dispose(): void {
    for (const backend of this.backendPromises) {
      void backend.then(
        (resolved) => resolved.dispose(),
        () => undefined,
      );
    }
    this.backendPromises.clear();
  }

  public cancel(target: RemoteTarget): void {
    if (target.kind !== this.kind) return;
    const key = target as object;
    const backend = this.backends.get(key);
    if (!backend) return;
    // Bug 原因：启动 10 秒超时过去只 reject 外层 Promise，SSH 握手仍在后台继续，
    // 迟到后会把 Source 注册 online。精确摘除本 target backend，后续手动重试可新建 transport。
    this.backends.delete(key);
    this.backendPromises.delete(backend);
    void backend.then(
      (resolved) => resolved.dispose(),
      () => undefined,
    );
  }

  private async getBackend(target: RemoteTarget): Promise<IRemoteBackend> {
    if (target.kind !== this.kind) {
      throw new Error(`Transport ${this.kind} cannot handle target ${target.kind}`);
    }
    const key = target as object;
    let backend = this.backends.get(key);
    if (!backend) {
      backend = this.createBackend(target);
      this.backends.set(key, backend);
      this.backendPromises.add(backend);
    }
    return await backend;
  }
}

export function createSourceServerTransportAdapter(
  kind: "ssh" | "wsl" | "docker",
  options: CreateSourceServerTransportAdapterOptions = {},
): SourceServerTransportAdapter {
  return new BackendSourceServerTransportAdapter(
    kind,
    options.createBackend ?? createRemoteBackend,
    options.rootReadPath ?? SOURCE_SERVER_DEFAULT_ROOT_READ_PATH,
  );
}
