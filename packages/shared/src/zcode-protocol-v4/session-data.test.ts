import { describe, expect, it } from "vitest";
import {
  v4SessionDataMeasureResultSchema,
  v4SessionDataParamsSchema,
  v4SessionDataPurgeResultSchema,
  v4SessionDeletionExecuteParamsSchema,
  v4SessionDeletionPreviewSchema,
  v4SessionDeletionResultSchema,
} from "./session-data.js";

describe("v4 sessionData contract", () => {
  it("accepts the measure/purge payloads and rejects unknown keys or negative bytes", () => {
    const params = {
      sessionIds: ["sess_1"],
      directories: [{ workspacePath: "/work/site", workspaceIdentity: "remote:ssh:dev" }],
    };
    expect(v4SessionDataParamsSchema.parse(params)).toEqual(params);
    expect(() => v4SessionDataParamsSchema.parse({ ...params, projects: ["p1"] })).toThrowError();

    expect(
      v4SessionDataMeasureResultSchema.parse({
        sessions: [{ sessionId: "sess_1", bytes: 0 }],
        memory: [{ workspacePath: "/work/site", bytes: 40 }],
      }),
    ).toBeTruthy();
    expect(() =>
      v4SessionDataMeasureResultSchema.parse({
        sessions: [{ sessionId: "sess_1", bytes: -1 }],
        memory: [],
      }),
    ).toThrowError();

    const purge = {
      deleted: [{ sessionId: "sess_1", bytes: 2048 }],
      kept: [{ sessionId: "sess_2", reason: "running" as const }],
      failed: [{ sessionId: "sess_3", code: "EBUSY" }],
      memory: [{ workspacePath: "/work/site", bytes: 40 }],
    };
    expect(v4SessionDataPurgeResultSchema.parse(purge)).toEqual(purge);
    // kept 原因只允许 running / referenced：别的字符串不能被当成保留理由。
    expect(() =>
      v4SessionDataPurgeResultSchema.parse({
        ...purge,
        kept: [{ sessionId: "s", reason: "busy" }],
      }),
    ).toThrowError();
    // failed 至少要有定位字段与错误码；仅 code 也可接受（目录级失败用 workspacePath）。
    expect(
      v4SessionDataPurgeResultSchema.parse({
        ...purge,
        failed: [{ workspacePath: "/work/site", code: "EACCES" }],
      }).failed,
    ).toHaveLength(1);
  });

  it("freezes the archived-session deletion preview/execute shapes", () => {
    const preview = {
      sessionId: "sess_1",
      revision: "rev-1",
      sessionIds: ["sess_1"],
      forks: [{ sessionId: "sess_2", title: "fork" }],
      retainedArtifacts: [
        {
          sessionId: "sess_1",
          artifactId: "img-1",
          fileName: "shot.png",
          referrers: [{ sessionId: "sess_2", title: "fork" }],
        },
      ],
      deletedFiles: 3,
      blockedReason: "running" as const,
      incomplete: false,
      completed: false,
    };
    expect(v4SessionDeletionPreviewSchema.parse(preview)).toEqual(preview);

    const execute = {
      sessionId: "sess_1",
      workspace: { workspacePath: "/work/site" },
      revision: "rev-1",
      operationId: "op-1",
    };
    expect(v4SessionDeletionExecuteParamsSchema.parse(execute)).toEqual(execute);
    // 会话 ID 拼进 CLI 路径，必须是单个安全文件名段。
    expect(() =>
      v4SessionDeletionExecuteParamsSchema.parse({ ...execute, sessionId: "../etc" }),
    ).toThrowError();
    expect(
      v4SessionDeletionResultSchema.parse({
        sessionId: "sess_1",
        status: "deleted",
        sessionIds: ["sess_1"],
        retainedArtifacts: 1,
      }),
    ).toMatchObject({ status: "deleted" });
  });
});
