import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { createSettingService, prepareTasksIndexStorage } from "@zcode/services/storage-startup";
import {
  classifyDatabaseStartupError,
  databaseStartupErrorDetails,
  databaseMigrationFactsSchema,
  parseRemoteWorkspaceIdentity,
} from "@zcode/shared";

const data = z
  .object({
    path: z.string().min(1),
    /** 可信持库 Host 身份；只能是既有 identity 工具解析出的值，不能由客户端请求注入。 */
    hostId: z.string().min(1).optional(),
  })
  .strict()
  .parse(workerData);
try {
  // Worker 必须携带旧设置完成项目迁移，否则后续 Host 只能看到已记账的空项目种子。
  const settings = await createSettingService().get();
  const hostId =
    data.hostId && (data.hostId === "local" || parseRemoteWorkspaceIdentity(data.hostId))
      ? data.hostId
      : undefined;
  const result = await prepareTasksIndexStorage(
    data.path,
    (phase, migration) => parentPort?.postMessage({ type: "progress", phase, migration }),
    settings,
    hostId,
  );
  parentPort?.postMessage({
    type: "done",
    backupSkipped: result.backupSkipped,
    backupSkippedPhases: result.backupSkippedPhases,
  });
} catch (error) {
  const migration = databaseMigrationFactsSchema.safeParse(
    error && typeof error === "object"
      ? (error as { startupMigration?: unknown }).startupMigration
      : undefined,
  );
  parentPort?.postMessage({
    type: "failed",
    migration: migration.success ? migration.data : undefined,
    errorCode: classifyDatabaseStartupError(error),
    ...databaseStartupErrorDetails(error),
  });
} finally {
  parentPort?.close();
}
