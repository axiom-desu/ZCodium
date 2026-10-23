import { mkdtemp } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { BashFileOutput } from "./bash-file-output.js";
import { NodeExecutionAdapterProcess } from "./node-execution-adapter-process.js";
import { resolveLegacyExecutionOutputEncoding } from "./outputEncoding.js";
import { isBashMergedOutputRequest, resolveDefaultOutputRootDir } from "./execution-utils.js";
import type { PreparedBashOutput } from "./execution-adapter-types.js";
import type { ExecutionRequest, ExecutionResult, ExecutionRunOptions } from "@zcode/contracts";

const BASH_TEMP_DIRECTORY_PREFIX = "zcode-bash-";
// Node 只在这些错误上降级；其它错误说明准备本身失败，必须显式报 spawn_error。
const BASH_TEMP_UNAVAILABLE_CODES = new Set([
  "EACCES",
  "EPERM",
  "EROFS",
  "ENOENT",
  "ENOTDIR",
  "ENOSPC",
  "EDQUOT",
]);

/** Bash 合并输出的路径与句柄冻结；tmp 隔离与降级都发生在 spawn 之前。 */
export class NodeExecutionAdapterBashOutput extends NodeExecutionAdapterProcess {
  private bashTempRoot?: Promise<string>;

  protected usesBashTempOutput(request: ExecutionRequest): boolean {
    return this.options.bashOutputTempDir !== undefined && isBashMergedOutputRequest(request);
  }

  private getBashTempRoot(): Promise<string> {
    if (!this.bashTempRoot) {
      const pending = mkdtemp(join(this.options.bashOutputTempDir!, BASH_TEMP_DIRECTORY_PREFIX));
      this.bashTempRoot = pending;
      // 失败不缓存，下一次 Bash 调用可以重试；成功目录在整个进程生命周期内共享。
      void pending.catch(() => {
        if (this.bashTempRoot === pending) this.bashTempRoot = undefined;
      });
    }
    return this.bashTempRoot;
  }

  /** 准备期取消/关闭：释放已打开句柄与 preparation 记录，只删除本次新建的空文件。 */
  protected async releasePreparedBashOutput(
    prepared: PreparedBashOutput | undefined,
  ): Promise<void> {
    await prepared?.file.discard();
    prepared?.releasePreparation();
  }

  protected async prepareBashOutput(
    request: ExecutionRequest,
    options: ExecutionRunOptions,
  ): Promise<{ prepared: PreparedBashOutput } | { result: ExecutionResult }> {
    const startedAt = new Date();
    let stopped = false;
    const executionId = this.registerActiveExecution(() => {
      stopped = true;
    });
    const releasePreparation = () => this.completeActiveExecution(executionId);
    const isStopped = () => stopped || this.closePromise !== undefined || options.signal?.aborted;
    let file: BashFileOutput | undefined;
    const cancelled = async () => {
      await file?.discard();
      releasePreparation();
      return {
        result: this.createStoppedResult(
          startedAt,
          "cancelled",
          "Execution cancelled before spawn",
        ),
      };
    };
    try {
      if (isStopped()) return await cancelled();
      const legacyOutputEncoding = resolveLegacyExecutionOutputEncoding({
        platform: this.platform,
        processEnv: this.processEnv,
      });
      const knownPath = this.outputPathForRequest(request, "stdout")!;
      // 请求可能被复用；缓存保存的是实际路径，降级根必须始终来自原有配置。
      const fallbackPath = join(
        this.options.outputRootDir ?? resolveDefaultOutputRootDir(this.options.processEnv),
        basename(dirname(knownPath)),
        basename(knownPath),
      );
      try {
        const root = await this.getBashTempRoot();
        if (isStopped()) return await cancelled();
        const path = join(root, basename(dirname(fallbackPath)), basename(fallbackPath));
        file = new BashFileOutput(path, this.platform, legacyOutputEncoding);
        await file.prepare();
      } catch (error) {
        if (isStopped()) return await cancelled();
        if (!BASH_TEMP_UNAVAILABLE_CODES.has((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
        await file?.discard();
        // 搜索数据目录会把正在写入的输出再次读回；优先隔离到 tmp，失败后完整复用旧文件实现。
        file = new BashFileOutput(fallbackPath, this.platform, legacyOutputEncoding);
        await file.prepare();
      }
      if (isStopped()) return await cancelled();
      // 路径必须在后台记录和文件入口发布之前确定，不能在 spawn 后再降级或重新打开。
      this.outputPathsByRequest.set(request, {
        outputPath: file.path,
        stdoutPersistedOutputPath: file.path,
      });
      return { prepared: { file, legacyOutputEncoding, releasePreparation } };
    } catch (error) {
      await file?.discard();
      releasePreparation();
      if (isStopped()) return await cancelled();
      return {
        result: this.createStoppedResult(
          startedAt,
          "spawn_error",
          this.toFailure("spawn_error", error).message,
        ),
      };
    }
  }
}
