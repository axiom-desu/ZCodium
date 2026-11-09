import { safeLogArgs } from "@zcode/shared";
import { spawn, execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { DockerConnectOptions, RemoteConnectionDomainError } from "@zcode/shared";
import type {
  IRemoteBackend,
  RemoteEnvironment,
  RemoteUploadOptions,
  StdioStream,
} from "@zcode/server/remote/backend.js";
import {
  createCloseEventController,
  resolveRemoteExitCode,
} from "@zcode/server/remote/closeEvent.js";
import {
  probeDockerDaemon,
  listDockerContainers,
  resolveDockerCommand,
  type DockerContainerInfo,
} from "@zcode/server/remote/docker-detect.js";
import {
  normalizeRemoteArch,
  normalizeRemotePlatform,
  resolveRemotePlatform,
} from "@zcode/server/remote/detectEnv.js";

interface ResolvedDockerInfo {
  containerName: string;
  homeDir: string;
}

const DOCKER_EXEC_MAX_BUFFER = 8 * 1024 * 1024;
const DOCKER_UPLOAD_MAX_STDERR_LENGTH = 2_048;

function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function normalizeDockerOutput(raw: string): string {
  return raw.replace(/\r/g, "");
}

function buildDockerExecArgs(containerName: string, commandArgs: string[]): string[] {
  return ["exec", "-i", containerName, ...commandArgs];
}

export class DockerBackend implements IRemoteBackend {
  private readonly dockerCommand = resolveDockerCommand();
  private readonly options: DockerConnectOptions;
  private resolvedInfoPromise: Promise<ResolvedDockerInfo> | null = null;
  private availabilityPromise: Promise<void> | null = null;

  constructor(options: DockerConnectOptions) {
    this.options = options;
  }

  async detect(): Promise<RemoteEnvironment> {
    await this.ensureAvailable();
    const reportedPlatform = normalizeRemotePlatform(
      normalizeDockerOutput(await this.execSimple("uname -s")),
    );
    const arch = normalizeRemoteArch(normalizeDockerOutput(await this.execSimple("uname -m")));
    const kernelOstype = await this.readKernelOstype();
    const platform = resolveRemotePlatform(reportedPlatform, kernelOstype);

    if (platform !== reportedPlatform) {
      // 测试容器里可能通过 wrapper 伪造了 uname 输出，
      // 这里只在发生回退时打一条低频日志，便于排查“为何最终按 Linux 选包”。
      console.warn(
        ...safeLogArgs([
          `[docker] detect: uname reported ${reportedPlatform}, but kernel ostype is ${kernelOstype}; fallback to ${platform}`,
        ]),
      );
    }

    return {
      platform,
      arch,
    };
  }

  async upload(
    localPath: string,
    remotePath: string,
    options?: RemoteUploadOptions,
  ): Promise<void> {
    await this.ensureAvailable();
    const resolvedInfo = await this.resolveInfo();
    const resolvedRemotePath = this.resolveLinuxPath(remotePath, resolvedInfo.homeDir);
    const parentDir = this.dirname(resolvedRemotePath);

    // 上传流不会帮我们创建父目录。
    // 如果直接写入 `~/.zcodium/server/...` 这类首次连接路径，上传会因为目录不存在而失败。
    // 先显式 `mkdir -p`，再由容器当前用户写入目标文件，和 SSH/WSL 保持一致。
    await this.execSimple(`mkdir -p ${quotePosixShellArg(parentDir)}`);

    // `docker cp` 复制到容器后的文件可能保留宿主 UID/GID，
    // 非 root 容器用户随后无法 chmod。统一由容器当前用户通过 stdin 写入，
    // 保证文件 owner 与后续部署命令的执行用户一致。
    await this.uploadViaExec(localPath, resolvedRemotePath, options ?? {});
  }

  private async uploadViaExec(
    localPath: string,
    resolvedRemotePath: string,
    options: RemoteUploadOptions,
  ): Promise<void> {
    const totalBytes = await stat(localPath).then((value) => value.size);
    if (options.signal?.aborted) {
      const error = new Error("Remote upload canceled");
      error.name = "AbortError";
      throw error;
    }
    const stream = await this.exec(`cat > ${quotePosixShellArg(resolvedRemotePath)}`);
    await new Promise<void>((resolve, reject) => {
      const readStream = createReadStream(localPath);
      const stdin = stream.stdin;
      let stderrText = "";
      let uploadedBytes = 0;
      let settled = false;
      const onStderr = (chunk: Buffer | string) => {
        stderrText = `${stderrText}${chunk.toString()}`.slice(-DOCKER_UPLOAD_MAX_STDERR_LENGTH);
      };
      stream.stderr.on("data", onStderr);
      const removeStderrListener = () => {
        stream.stderr.removeListener("data", onStderr);
      };
      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        removeStderrListener();
        readStream.destroy();
        const destroyable = stdin as NodeJS.WritableStream & {
          destroy?: (reason?: Error) => void;
        };
        destroyable.destroy?.(error);
        reject(error);
      };
      const abort = () => {
        const error = new Error("Remote upload canceled");
        error.name = "AbortError";
        finishError(error);
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      readStream.on("data", (chunk: Buffer) => {
        uploadedBytes += chunk.length;
        options.onProgress?.({ uploadedBytes, totalBytes });
      });
      readStream.on("error", finishError);
      stdin.on("error", finishError);
      stream.onClose((code) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        removeStderrListener();
        if (code !== 0) {
          const stderrSummary = normalizeDockerOutput(stderrText).trim();
          reject(
            new Error(
              stderrSummary
                ? `Docker upload failed with exit code ${code}: ${stderrSummary}`
                : `Docker upload failed with exit code ${code}`,
            ),
          );
          return;
        }
        options.onProgress?.({ uploadedBytes: totalBytes, totalBytes });
        resolve();
      });
      readStream.pipe(stdin);
    });
  }

  async exec(command: string): Promise<StdioStream> {
    await this.ensureAvailable();
    const resolvedInfo = await this.resolveInfo();

    return new Promise((resolve, reject) => {
      const child = spawn(
        this.dockerCommand,
        buildDockerExecArgs(resolvedInfo.containerName, ["sh", "-lc", command]),
        {
          stdio: "pipe",
          windowsHide: true,
        },
      );

      child.once("error", reject);
      child.once("spawn", () => {
        const stdin = child.stdin;
        const stdout = child.stdout;
        const stderr = child.stderr;
        if (!stdin || !stdout || !stderr) {
          reject(new Error("Docker exec stdio is not available"));
          return;
        }

        const onClose = createCloseEventController();
        let fired = false;
        const fireOnce = (code: number) => {
          if (fired) {
            return;
          }
          fired = true;
          onClose.fire(code);
        };

        // signal 终止不是成功，见 resolveRemoteExitCode。
        child.on("exit", (code, signal) => {
          fireOnce(resolveRemoteExitCode(code, signal));
        });
        child.on("close", (code, signal) => {
          fireOnce(resolveRemoteExitCode(code, signal));
        });

        resolve({
          stdin,
          stdout,
          stderr,
          onClose: onClose.event,
        });
      });
    });
  }

  async exists(remotePath: string): Promise<boolean> {
    try {
      const resolvedInfo = await this.resolveInfo();
      const resolvedRemotePath = this.resolveLinuxPath(remotePath, resolvedInfo.homeDir);
      await this.execSimple(`test -f ${quotePosixShellArg(resolvedRemotePath)} && printf OK`);
      return true;
    } catch {
      return false;
    }
  }

  async readFile(remotePath: string): Promise<string> {
    const resolvedInfo = await this.resolveInfo();
    const resolvedRemotePath = this.resolveLinuxPath(remotePath, resolvedInfo.homeDir);
    return normalizeDockerOutput(
      await this.execSimple(`cat ${quotePosixShellArg(resolvedRemotePath)}`),
    );
  }

  dispose(): void {
    // Docker backend 的命令都是一次性子进程，没有常驻连接需要显式清理。
  }

  async diagnoseExecFailure(): Promise<void> {
    // Bug 原因：daemon 可能在成功探测之后停止，失败后必须丢弃旧缓存再诊断。
    this.availabilityPromise = null;
    await this.ensureAvailable();
  }

  private async ensureAvailable(): Promise<void> {
    if (!this.availabilityPromise) {
      const probing = probeDockerDaemon().catch((error: unknown) => {
        if (this.availabilityPromise === probing) this.availabilityPromise = null;
        // Bug 原因：布尔探测丢掉 CLI 原因，无法区分未安装、daemon 停止与 socket 权限。
        // 仅设 unknown 仍会被 shared 沿 cause 改码；显式领域边界保留 daemon 分类与原始 cause。
        const detail = error instanceof Error ? error.message.trim() : String(error);
        throw Object.assign(
          new Error(
            detail
              ? `当前系统未检测到可用的 Docker 环境：${detail}`
              : "当前系统未检测到可用的 Docker 环境",
            { cause: error },
          ),
          {
            code: "remote-connection-unknown",
            remoteConnectionErrorKind: "domain",
          } satisfies RemoteConnectionDomainError,
        );
      });
      this.availabilityPromise = probing;
    }
    await this.availabilityPromise;
  }

  private async resolveInfo(): Promise<ResolvedDockerInfo> {
    if (this.resolvedInfoPromise) {
      return this.resolvedInfoPromise;
    }

    this.resolvedInfoPromise = (async () => {
      const container = await this.resolveContainer();
      const homeDir = normalizeDockerOutput(
        await this.execDirect(["sh", "-lc", "printf %s ~"]),
      ).trim();

      return {
        containerName: container.name,
        homeDir,
      };
    })();

    return this.resolvedInfoPromise;
  }

  private async resolveContainer(): Promise<DockerContainerInfo> {
    const containers = await listDockerContainers({ all: true });
    const matched = containers.find(
      (container) =>
        container.name === this.options.container ||
        container.id === this.options.container ||
        container.id.startsWith(this.options.container),
    );

    if (!matched) {
      throw new Error(`未找到名为 ${this.options.container} 的 Docker 容器`);
    }

    if (matched.state.toLowerCase() !== "running") {
      throw new Error(
        `Docker 容器 ${matched.name} 当前未运行（state=${matched.state || "unknown"}）`,
      );
    }

    return matched;
  }

  private resolveLinuxPath(remotePath: string, homeDir: string): string {
    if (remotePath === "~") {
      return homeDir;
    }

    if (remotePath.startsWith("~/")) {
      return `${homeDir.replace(/\/$/, "")}/${remotePath.slice(2)}`;
    }

    return remotePath;
  }

  private dirname(remotePath: string): string {
    const normalized = remotePath.replace(/\/+/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    if (lastSlash <= 0) {
      return "/";
    }

    return normalized.slice(0, lastSlash);
  }

  private async execSimple(command: string): Promise<string> {
    return this.execDirect(["sh", "-lc", command]);
  }

  private async readKernelOstype(): Promise<string> {
    try {
      return normalizeDockerOutput(
        await this.execSimple(
          "if [ -r /proc/sys/kernel/ostype ]; then cat /proc/sys/kernel/ostype; fi",
        ),
      ).trim();
    } catch {
      return "";
    }
  }

  private async execDirect(commandArgs: string[]): Promise<string> {
    const container = await this.resolveContainer();
    return new Promise((resolve, reject) => {
      execFile(
        this.dockerCommand,
        buildDockerExecArgs(container.name, commandArgs),
        {
          encoding: "utf8",
          maxBuffer: DOCKER_EXEC_MAX_BUFFER,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(normalizeDockerOutput(stderr).trim() || error.message));
            return;
          }

          resolve(normalizeDockerOutput(stdout));
        },
      );
    });
  }
}
