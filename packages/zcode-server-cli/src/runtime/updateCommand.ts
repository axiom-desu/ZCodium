import { updatePreparationResultSchema } from "../contracts.js";
import { ControlRequestError } from "../ipc/controlError.js";
import { requestControl } from "../ipc/controlClient.js";
import { createServiceLogger } from "@zcode/services/node";
import { isAbsolute } from "node:path";
import {
  SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
  type SourceServerInstallProgress,
} from "@zcode/shared";
import type { ReleaseManifest } from "../contracts.js";
import { DataRootLock } from "./lock.js";
import { currentServerTarget } from "./manifest.js";
import type { ServerLayout } from "./paths.js";
import { ReleaseInstaller } from "./releaseInstaller.js";
import { ReleaseManager } from "./releaseManager.js";
import { prepareOnlineUpdate } from "./updatePreparation.js";

interface UpdateCliIO {
  stdout?: { write(value: string): void };
}

function stdout(io: UpdateCliIO, value: unknown): void {
  io.stdout?.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}

function isRunningTaskUpdateGuard(error: unknown): boolean {
  return (
    (error instanceof ControlRequestError &&
      error.code === SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE) ||
    (error instanceof Error && error.message.includes("Running tasks require --force for update"))
  );
}

function createRunningTaskUpdateGuard(): ControlRequestError {
  return new ControlRequestError(
    SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
    "Running tasks require --force for update",
    false,
  );
}

function readSingleOption(argv: readonly string[], name: string): string | undefined {
  const indexes = argv.flatMap((value, index) => (value === name ? [index] : []));
  if (indexes.length > 1) throw new Error(`${name} may only be specified once`);
  const index = indexes[0];
  if (index === undefined) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

function isControlEndpointUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "EINVAL")
  );
}

/**
 * 本地 archive 更新：复用 ReleaseInstaller 的 target/tar/内容哈希校验。
 * 默认先走 control prepare-update 的 running-task guard；`--force` 只跳过忙碌许可，
 * 不跳过 archive、target、完整性或身份校验。
 */
export async function runLocalArchiveUpdateCommand(
  argv: readonly string[],
  io: UpdateCliIO,
  json: boolean,
  layout: ServerLayout,
  applyUpdate: () => Promise<unknown>,
): Promise<number> {
  const archivePath = readSingleOption(argv, "--from-archive");
  if (!archivePath) throw new Error("--from-archive requires a path");
  if (!isAbsolute(archivePath)) throw new Error("--from-archive must be an absolute path");
  const force = argv.includes("--force");
  const onProgress = (phase: SourceServerInstallProgress["phase"]): void => {
    if (json && argv.includes("--progress")) {
      stdout(io, {
        type: "source-server-install-progress",
        phase,
      } satisfies SourceServerInstallProgress);
    }
  };
  let daemonOnline = false;
  if (!force) {
    try {
      const result = updatePreparationResultSchema.parse(
        await requestControl(layout.controlEndpoint, { command: "prepare-update" }),
      );
      daemonOnline = true;
      if (result.status === "blocked") throw createRunningTaskUpdateGuard();
    } catch (error) {
      if (!isControlEndpointUnavailable(error)) throw error;
    }
  } else {
    try {
      await requestControl(layout.controlEndpoint, { command: "status" });
      daemonOnline = true;
    } catch (error) {
      if (!isControlEndpointUnavailable(error)) throw error;
    }
  }
  const releaseManager = new ReleaseManager(layout);
  // 安装 + pending 指针 + 第二次忙碌检查必须在同一个更新事务里。没有锁时，两个本地 archive
  // 更新可以同时写 pending.json，失败回滚会把另一进程刚写入的合法 pending 清掉。
  const updateLock = new DataRootLock(
    layout.updateLockFile,
    "Another ZCode Server update is already in progress",
  );
  await updateLock.acquire();
  let pendingBefore: ReleaseManifest | null = null;
  let prepared: ReleaseManifest | null = null;
  try {
    pendingBefore = await releaseManager.readPending();
    const previous = await releaseManager.readCurrent();
    prepared = await new ReleaseInstaller(layout).installArchive({
      archivePath,
      target: currentServerTarget(),
      onProgress,
    });
    if (daemonOnline) {
      if (!force) {
        const result = updatePreparationResultSchema.parse(
          await requestControl(layout.controlEndpoint, { command: "prepare-update" }),
        );
        // 任务在解压期间开始：本次安装不能留下未被确认的 pending，否则后续离线更新会
        // 应用这个被忙碌 guard 拒绝的版本。只回滚本次写入的 receipt，并恢复原先 pending。
        if (result.status === "blocked") throw createRunningTaskUpdateGuard();
      }
      onProgress("restart");
      await applyUpdate();
      const result = { applied: true, installed: false, version: prepared.version };
      if (json) stdout(io, result);
      else stdout(io, `ZCode Server ${prepared.version} updated`);
      return 0;
    }
    await releaseManager.applyPendingWithTransaction(previous);
    await releaseManager.completeUpdate();
    const result = { applied: true, installed: previous === null, version: prepared.version };
    if (json) stdout(io, result);
    else stdout(io, `ZCode Server ${prepared.version} ${previous ? "updated" : "installed"}`);
    return 0;
  } catch (error) {
    if (prepared) await rollbackOwnedPendingBestEffort(releaseManager, prepared, pendingBefore);
    throw error;
  } finally {
    await updateLock.release();
  }
}

/**
 * 只在 pending 仍指向本次安装（releaseId + archiveSha256 相同）时回滚：
 * 原地恢复失败前的 pending，没有旧 pending 才删除。绝不按版本号猜测，
 * 也不清掉锁外/并发写入的不同 artifact。
 */
async function rollbackOwnedPending(
  releaseManager: ReleaseManager,
  prepared: ReleaseManifest,
  pendingBefore: ReleaseManifest | null,
): Promise<void> {
  const current = await releaseManager.readPending();
  if (!current) return;
  if (
    current.releaseId !== prepared.releaseId ||
    current.archiveSha256 !== prepared.archiveSha256
  ) {
    return;
  }
  if (pendingBefore) await releaseManager.writePending(pendingBefore);
  else await releaseManager.removePending();
}

async function rollbackOwnedPendingBestEffort(
  releaseManager: ReleaseManager,
  prepared: ReleaseManifest,
  pendingBefore: ReleaseManifest | null,
): Promise<void> {
  try {
    await rollbackOwnedPending(releaseManager, prepared, pendingBefore);
  } catch (error: unknown) {
    // 回滚失败不能掩盖 running-task guard；保留 marker 让下一次启动/更新继续 fail closed。
    log.warn("failed to roll back update pending after command failure", error);
  }
}

const log = createServiceLogger("server-update-command");

async function discardPreparedUpdateBestEffort(
  discard: (() => Promise<void>) | undefined,
): Promise<void> {
  if (!discard) return;
  try {
    await discard();
  } catch (error: unknown) {
    // 准备产物清理属于非关键收尾；直接 await discard 会让清理失败覆盖
    // running-task guard 或 control socket 的原始错误，导致用户看到错误的排障方向。
    log.warn("failed to discard prepared update after command failure", error);
  }
}

export async function runUpdateCommand(
  argv: readonly string[],
  io: UpdateCliIO,
  json: boolean,
  layout: ServerLayout,
  applyUpdate: () => Promise<number>,
): Promise<number> {
  const force = argv.includes("--force");
  let discardPreparedUpdate: (() => Promise<void>) | undefined;
  if (!force) {
    // prepareOnlineUpdate 会下载、解压并写入 pending release；旧流程在准备完成后
    // 才由 apply-update 检查运行任务，导致 guard 拒绝时仍留下网络和磁盘副作用。先检查已知的
    // 运行任务，并在准备完成后再次检查；最终 apply-update guard 仍覆盖最后一小段竞态。
    const result = updatePreparationResultSchema.parse(
      await requestControl(layout.controlEndpoint, { command: "prepare-update" }),
    );
    if (result.status === "blocked") throw new Error("Running tasks require --force for update");
  }
  const preparation = await prepareOnlineUpdate(layout);
  discardPreparedUpdate = "discard" in preparation ? preparation.discard : undefined;
  if (preparation.status === "up-to-date") {
    if (json) stdout(io, preparation);
    else stdout(io, `ZCode Server ${preparation.version} is already up to date`);
    return 0;
  }
  if (!force && discardPreparedUpdate) {
    const discard = discardPreparedUpdate;
    try {
      const result = updatePreparationResultSchema.parse(
        await requestControl(layout.controlEndpoint, { command: "prepare-update" }),
      );
      if (result.status === "blocked") {
        await discardPreparedUpdateBestEffort(discard);
        discardPreparedUpdate = undefined;
        throw new Error("Running tasks require --force for update");
      }
    } catch (error: unknown) {
      if (isRunningTaskUpdateGuard(error)) throw error;
      await discardPreparedUpdateBestEffort(discard);
      discardPreparedUpdate = undefined;
      throw error;
    }
  }
  try {
    const result = await applyUpdate();
    discardPreparedUpdate = undefined;
    return result;
  } catch (error: unknown) {
    if (isRunningTaskUpdateGuard(error)) {
      await discardPreparedUpdateBestEffort(discardPreparedUpdate);
      discardPreparedUpdate = undefined;
    }
    throw error;
  }
}
