import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectTrace, listTraces } from "../server/analyzer.js";

const traceId = "fixture-trace";

function eventLine(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

async function withFixture(
  run: (paths: { dbPath: string; eventPath: string; logDir: string }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "zcodium-analyzer-"));
  const logDir = join(directory, "logs");
  const eventPath = join(directory, "events.jsonl");
  await mkdir(logDir);
  await writeFile(
    eventPath,
    [
      eventLine({
        id: "event-user",
        type: "user_message",
        timestamp: "2026-01-01T00:00:00.000Z",
        traceId,
        sessionId: "session-a",
        turnId: "turn-1",
        payload: { content: "观察这个 trace" },
      }),
      eventLine({
        id: "event-model-start",
        type: "model_request",
        timestamp: "2026-01-01T00:00:01.000Z",
        traceId,
        sessionId: "session-a",
        turnId: "turn-1",
        payload: {
          model: "fixture-model",
          usage: { input: 10, output: 4, total: 14, cacheReadTokens: 5, cacheWriteTokens: 1 },
          messages: [
            { role: "system", content: "# System\n身份说明\n# Tools\n工具说明" },
            { role: "user", content: "观察这个 trace" },
          ],
        },
      }),
      eventLine({
        id: "event-model-end",
        type: "model_complete",
        timestamp: "2026-01-01T00:00:03.000Z",
        traceId,
        sessionId: "session-a",
        turnId: "turn-1",
        payload: {
          usage: { input: 10, output: 4, total: 14, cacheReadTokens: 5, cacheWriteTokens: 1 },
        },
      }),
    ].join(""),
  );
  try {
    await run({ dbPath: join(directory, "missing.sqlite"), eventPath, logDir });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("trace 列表按事件汇总首条用户消息与缓存 token", async () => {
  await withFixture(async (paths) => {
    const response = await listTraces(paths);
    assert.equal(response.traces.length, 1);
    const trace = response.traces[0];
    assert.equal(trace?.traceId, traceId);
    assert.equal(trace?.eventCount, 3);
    assert.deepEqual(trace?.sessionIds, ["session-a"]);
    assert.equal(trace?.firstUserMessage, "观察这个 trace");
    assert.equal(trace?.cacheReadTokens, 10);
    assert.equal(trace?.cacheWriteTokens, 2);
    assert.equal(trace?.lastMessage, "model_complete");
    assert.equal(response.sources.find((source) => source.kind === "eventlog")?.recordCount, 3);
  });
});

test("trace 详情拆出时间线、执行段、上下文快照与缓存报告", async () => {
  await withFixture(async (paths) => {
    const detail = await inspectTrace(traceId, paths);

    assert.deepEqual(detail.sessions, ["session-a"]);
    assert.equal(detail.timeline.length, 3);
    assert.equal(detail.timeline[0]?.kind, "model_complete");
    const userItem = detail.timeline.find((item) => item.kind === "user_message");
    assert.equal(userItem?.summary.startsWith("观察这个 trace"), true);

    const modelSpan = detail.spans.find((span) => span.lane === "model");
    assert.ok(modelSpan);
    assert.equal(modelSpan.status, "ok");
    assert.equal(modelSpan.traceId, traceId);
    assert.equal(modelSpan.startAt, "2026-01-01T00:00:01.000Z");
    assert.equal(modelSpan.endAt, "2026-01-01T00:00:03.000Z");

    const snapshot = detail.contextSnapshots.at(-1);
    assert.ok(snapshot);
    assert.equal(snapshot.observationLevel, "full");
    assert.equal(snapshot.sections.length, 2);
    assert.deepEqual(
      snapshot.sections.map((section) => section.source),
      ["system_prompt", "tools"],
    );
    assert.ok(snapshot.totalTokens > 0);

    const report = detail.cacheReports.at(-1);
    assert.ok(report);
    assert.equal(report.cacheReadTokens, 5);
    assert.equal(report.cacheWriteTokens, 1);
    assert.equal(report.segments.length, 2);

    assert.ok(
      detail.developerRequests.some((request) => request.eventName === "prompt_cache_report"),
    );
    assert.equal(
      detail.developerRequests.some((request) => request.eventName === "session_event_jsonl_sink"),
      false,
    );
  });
});

test("同一 trace 的上下文占用快照会拆分 token 分类", async () => {
  await withFixture(async (paths) => {
    const detail = await inspectTrace(traceId, paths);
    const usageSnapshot = detail.contextUsageSnapshots.at(-1);
    assert.equal(usageSnapshot, undefined);
    const textSnapshot = detail.contextSnapshots.at(-1);
    assert.equal(
      textSnapshot?.sections.reduce((sum, section) => sum + section.tokens, 0),
      textSnapshot?.totalTokens,
    );
  });
});
