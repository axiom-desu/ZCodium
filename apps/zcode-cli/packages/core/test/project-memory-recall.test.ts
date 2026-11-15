import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat as statPath,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";

import type { FileSystemPort, Model, ModelRequest } from "@zcode/contracts";

import {
  acquireDreamLock,
  buildMemoryDreamPrompt,
  collectDreamTouchedPaths,
  evaluateAutoDreamTiming,
  readDreamLastConsolidatedAt,
  restoreDreamLockAfterFailure,
} from "../src/memory/dream.js";
import { selectProjectDreamSessions } from "../src/runtime/helpers/project-memory-dream.js";
import {
  MEMORY_RECALL_SESSION_CHARACTER_LIMIT,
  buildMemorySelectorRequest,
  canStartMemoryRecall,
  createMemoryRecallState,
  filterMemorySelections,
  findLatestMemoryRecallQuery,
  formatRelevantMemoryAttachment,
  getMemoryRecallManifest,
  isMemoryRecallQueryEligible,
  readRecalledMemories,
  recordRecalledMemories,
  runMemorySelector,
  scanMemoryManifest,
} from "../src/memory/recall/index.js";
import type { MemoryRecallState } from "../src/memory/recall/types.js";
import {
  consumeSettledProjectMemoryRecall,
  disposeProjectMemoryRecallPrefetch,
  invalidateProjectMemoryRecallPaths,
  resetProjectMemoryRecall,
  startProjectMemoryRecallPrefetch,
  type ProjectMemoryRecallPrefetch,
} from "../src/runtime/helpers/project-memory-recall.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { ReadFileStateMap } from "../src/tool/types.js";

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function createMemoryDir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-memory-recall-"));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, relativePath);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return root;
}

/** 真实文件系统端口子集：Recall 只用到列目录、stat 与范围读。 */
function createFileSystemPort(): FileSystemPort {
  return {
    async listDirectory({ path }: { path: string }) {
      const entries = await readdir(path, { withFileTypes: true });
      return {
        entries: entries.map((entry) => ({
          kind: entry.isDirectory()
            ? "directory"
            : entry.isSymbolicLink()
              ? "symlink"
              : entry.isFile()
                ? "file"
                : "other",
          path: join(path, entry.name),
        })),
      };
    },
    async stat({ path }: { path: string }) {
      // 与 Node 适配器一致：stat 跟随 symlink，得到目标节点类型。
      const info = await statPath(path);
      return {
        kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
        mtimeMs: info.mtimeMs,
        path,
        sizeBytes: info.size,
      };
    },
    async readTextFileRange({ path, limitLines }: { path: string; limitLines: number }) {
      const content = await readFile(path, "utf8");
      const lines = content.split("\n");
      const selected = lines.slice(0, limitLines);
      return {
        content: selected.join("\n"),
        encoding: "utf8",
        bytesRead: Buffer.byteLength(content, "utf8"),
        lineCount: selected.length,
        path,
        sizeBytes: Buffer.byteLength(content, "utf8"),
        startLine: 1,
        totalLines: lines.length,
        truncated: selected.length < lines.length,
      };
    },
    async readTextFile({ path }: { path: string }) {
      const content = await readFile(path, "utf8");
      const info = await statPath(path);
      return {
        bytesRead: Buffer.byteLength(content, "utf8"),
        content,
        encoding: "utf8",
        path,
        sizeBytes: info.size,
        truncated: false,
        revision: { id: `rev-${info.mtimeMs}`, mtimeMs: info.mtimeMs, sizeBytes: info.size },
      };
    },
  } as unknown as FileSystemPort;
}

interface RecordedModel {
  model: Model;
  requests: ModelRequest[];
}

function createRecordingModel(input?: {
  response?: (request: ModelRequest) => string;
  supportsJsonSchemaOutput?: boolean;
}): RecordedModel {
  const requests: ModelRequest[] = [];
  const model = {
    bind: () => model,
    generateText: async (request: ModelRequest) => {
      requests.push(request);
      return {
        finishReason: "stop",
        text: input?.response?.(request) ?? '{"selected_memories":[]}',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    modelId: "fixture-model",
    optionSpecs: {
      maxOutputTokens: { map: {}, max: 32_000 },
      reasoningLevel: { map: {}, values: ["none"] },
    },
    properties: {
      contextWindow: 200_000,
      inputFormat: {
        supportsAudio: false,
        supportsImage: false,
        supportsPdf: false,
        supportsText: true,
        supportsVideo: false,
      },
      outputFormat: { supportsText: true },
      requiresMfjsToolSchema: false,
      supportsJsonSchemaOutput: input?.supportsJsonSchemaOutput ?? true,
      supportsMidConversationSystem: true,
      supportsNativeWebSearch: false,
      supportsToolCall: true,
    },
    providerId: "fixture-provider",
  } as unknown as Model;
  return { model, requests };
}

interface RecallRuntimeStub {
  fileSystemPort?: FileSystemPort;
  logger?: AgentRuntimeInternal["logger"];
  memoryRecallPrefetch?: ProjectMemoryRecallPrefetch;
  memoryRecallState: MemoryRecallState;
  memoryRoot?: string;
  messageHistory: AgentRuntimeInternal["messageHistory"];
  now: AgentRuntimeInternal["now"];
  readFileState: ReadFileStateMap;
  trackResidencyBlockingWork: AgentRuntimeInternal["trackResidencyBlockingWork"];
}

function createRecallRuntimeStub(input?: {
  entries?: readonly unknown[];
  withMemory?: { fileSystem: FileSystemPort; rootDir: string };
}): RecallRuntimeStub {
  return {
    ...(input?.withMemory
      ? { fileSystemPort: input.withMemory.fileSystem, memoryRoot: input.withMemory.rootDir }
      : {}),
    memoryRecallState: createMemoryRecallState(),
    messageHistory: {
      borrowReadOnlyRuntimeEntries: () => (input?.entries ?? []) as never,
    } as unknown as AgentRuntimeInternal["messageHistory"],
    now: () => new Date(),
    readFileState: new Map(),
    trackResidencyBlockingWork: <T>(work: Promise<T>) => work,
  };
}

function userEntry(text: string, source?: string) {
  return {
    message: { content: text, role: "user" as const },
    ...(source ? { metadata: { source } } : {}),
  };
}

it("manifest 递归扫描 .md、排除 MEMORY.md、按 mtime 降序且无 metadata 也可入选", async () => {
  const root = await createMemoryDir({
    "MEMORY.md": "- index\n",
    "old.md": "---\ndescription: old fact\nmetadata:\n  type: feedback\n---\nbody\n",
    "nested/new.md": "plain markdown, no frontmatter\n",
    "nested/broken.md": "---\n: bad yaml : [\n---\nbody\n",
  });
  const oldPath = join(root, "old.md");
  await utimes(oldPath, new Date("2020-01-01"), new Date("2020-01-01"));

  const manifest = await scanMemoryManifest({ fileSystem: createFileSystemPort(), rootDir: root });
  assert.deepEqual(
    manifest.map((entry) => entry.filename),
    ["nested/broken.md", "nested/new.md", "old.md"],
  );
  const old = manifest.find((entry) => entry.filename === "old.md");
  assert.equal(old?.description, "old fact");
  assert.equal(old?.type, "feedback");
  // frontmatter 解析失败仍作为无 metadata 候选进入 manifest。
  assert.equal(manifest.find((entry) => entry.filename === "nested/broken.md")?.description, undefined);
});

it("manifest 不跟随目录 symlink，但普通文件 symlink 仍可入选", async () => {
  const root = await createMemoryDir({ "real/fact.md": "fact\n" });
  const outside = await createMemoryDir({ "escape.md": "outside\n" });
  await symlink(outside, join(root, "linked-dir"));
  await symlink(join(outside, "escape.md"), join(root, "linked-file.md"));

  const manifest = await scanMemoryManifest({ fileSystem: createFileSystemPort(), rootDir: root });
  assert.deepEqual(
    manifest.map((entry) => entry.filename).sort(),
    ["linked-file.md", "real/fact.md"],
  );
});

it("manifest 非空时对 session sticky，空扫描不缓存", async () => {
  const state = createMemoryRecallState();
  const emptyRoot = await createMemoryDir({});
  const fileSystem = createFileSystemPort();
  assert.deepEqual(await getMemoryRecallManifest({ fileSystem, rootDir: emptyRoot, state }), []);
  assert.equal(state.manifest, undefined);

  const root = await createMemoryDir({ "fact.md": "fact\n" });
  const first = await getMemoryRecallManifest({ fileSystem, rootDir: root, state });
  assert.equal(first.length, 1);
  assert.equal(state.selectorMessages?.length, 1);
  await writeFile(join(root, "second.md"), "second\n", "utf8");
  const second = await getMemoryRecallManifest({ fileSystem, rootDir: root, state });
  assert.equal(second.length, 1, "非空 manifest 必须 sticky，不重新扫描");
});

it("selector query 只取最新非 meta user：real_user 以 metadata 为准，缺 metadata 才看文本前缀", () => {
  const entries = [
    userEntry("older question", "real_user"),
    userEntry("<system-reminder>reminder</system-reminder>", "real_user"),
    { kind: "attachment" as const, content: "x", metadata: { source: "relevant_memory" } },
  ];
  assert.equal(
    findLatestMemoryRecallQuery(entries as never),
    "<system-reminder>reminder</system-reminder>",
  );
  assert.equal(
    findLatestMemoryRecallQuery([userEntry("<system-reminder>x</system-reminder>")] as never),
    undefined,
  );
  assert.equal(findLatestMemoryRecallQuery([userEntry("one-word")] as never), "one-word");
  assert.equal(isMemoryRecallQueryEligible("one-word"), false);
  assert.equal(isMemoryRecallQueryEligible("  "), false);
  assert.equal(isMemoryRecallQueryEligible("two words"), true);
});

it("selector 请求携带冻结 schema、manifest conversation 与当前同一 model 的输出档位", async () => {
  const { model, requests } = createRecordingModel();
  const state = createMemoryRecallState();
  state.manifest = [
    { description: "db policy", filePath: "/mem/db.md", filename: "db.md", mtimeMs: 1 },
  ];
  const request = buildMemorySelectorRequest({ query: "apply the database policy", state });
  assert.equal(request.messages[0]?.role, "system");
  assert.match(String(request.messages[0]?.content), /selecting memories/u);
  assert.match(String(request.messages[1]?.content), /db\.md/u);
  assert.deepEqual(request.messages[2], {
    content: "Select memories relevant to:\napply the database policy",
    cacheControl: { type: "ephemeral" },
    role: "user",
  });
  assert.deepEqual(request.responseJsonSchema?.required, ["selected_memories"]);
  assert.equal(request.responseJsonSchema?.additionalProperties, false);

  const selection = await runMemorySelector({ model, query: "apply policy", state });
  assert.deepEqual(selection, { selectedKnowledgeIds: [], selectedMemories: [] });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.abortSignal, undefined);
  assert.equal(requests[0]?.options?.maxOutputTokens, 5_000);
  assert.equal(requests[0]?.options?.reasoningLevel, "none");
});

it("selector 非法 JSON、额外字段、abort 都是空选择且不污染 sticky conversation", async () => {
  const state = createMemoryRecallState();
  state.manifest = [{ filePath: "/mem/db.md", filename: "db.md", mtimeMs: 1 }];
  const baseConversation = state.selectorMessages;

  for (const response of [
    "not json",
    '{"selected_memories":["db.md"],"extra":1}',
    '{"selected_memories":[1]}',
  ]) {
    const { model } = createRecordingModel({ response: () => response });
    assert.deepEqual(await runMemorySelector({ model, query: "q x", state }), {
      selectedKnowledgeIds: [],
      selectedMemories: [],
    });
  }
  assert.equal(state.selectorMessages, baseConversation);

  const abortController = new AbortController();
  abortController.abort();
  const aborted = createRecordingModel({ response: () => '{"selected_memories":["db.md"]}' });
  assert.deepEqual(
    await runMemorySelector({
      abortSignal: abortController.signal,
      model: aborted.model,
      query: "q x",
      state,
    }),
    { selectedKnowledgeIds: [], selectedMemories: [] },
  );
  assert.equal(state.selectorMessages, baseConversation);

  const ok = createRecordingModel({ response: () => '{"selected_memories":["db.md","db.md"]}' });
  assert.deepEqual(await runMemorySelector({ model: ok.model, query: "q x", state }), {
    selectedKnowledgeIds: [],
    selectedMemories: ["db.md", "db.md"],
  });
  assert.equal(state.selectorMessages?.at(-1)?.role, "assistant");
});

it("选择过滤保留模型顺序与同批重复，过滤已读/已 Recall/不存在，并截断到 5 项", () => {
  const manifest = Array.from({ length: 8 }, (_, index) => ({
    filePath: `/mem/f${index}.md`,
    filename: `f${index}.md`,
    mtimeMs: 1,
  }));
  const readFileState: ReadFileStateMap = new Map();
  readFileState.set("/mem/f1.md\u00001\u0000", {
    content: "x",
    isPartialView: false,
    path: "/mem/f1.md",
    readAt: new Date(),
  });
  const recalledPaths = new Set(["/mem/f2.md"]);

  const selected = filterMemorySelections({
    manifest,
    readFileState,
    recalledPaths,
    selectedFilenames: [
      "f2.md",
      "missing.md",
      "f1.md",
      "f0.md",
      "f0.md",
      "f3.md",
      "f4.md",
      "f5.md",
    ],
  });
  assert.deepEqual(
    selected.map((entry) => entry.filename),
    ["f0.md", "f0.md", "f3.md", "f4.md", "f5.md"],
  );
});

it("正文按 4096 bytes 截断并追加冻结 suffix，stale > 1 天才提示", async () => {
  const longLine = "x".repeat(64);
  const root = await createMemoryDir({
    "big.md": Array.from({ length: 300 }, () => longLine).join("\n"),
  });
  const fileSystem = createFileSystemPort();
  const [memory] = await readRecalledMemories({
    entries: [{ filePath: join(root, "big.md"), filename: "big.md", mtimeMs: 0 }],
    fileSystem,
    nowMs: 10 * 86_400_000,
  });
  assert.ok(memory);
  assert.match(memory.content, /4096 byte limit/u);
  assert.match(memory.content, /Use the Read tool to view the complete file at:/u);
  assert.notEqual(memory.limit, undefined);
  assert.match(memory.header, /This memory is 10 days old\./u);
  const body = memory.content.split("\n\n> This memory file")[0]!;
  assert.ok(Buffer.byteLength(body, "utf8") <= 4096);

  const [fresh] = await readRecalledMemories({
    entries: [{ filePath: join(root, "big.md"), filename: "big.md", mtimeMs: 86_400_000 }],
    fileSystem,
    nowMs: 2 * 86_400_000,
  });
  assert.match(fresh!.header, /^Memory: /u);
  assert.match(formatRelevantMemoryAttachment([memory]), /^Retrieved for possible relevance/u);
});

it("会话字符上限 61,440：达到后不再启动新的 Recall", () => {
  const state = createMemoryRecallState();
  assert.equal(canStartMemoryRecall(state), true);
  recordRecalledMemories(state, [
    {
      content: "x".repeat(MEMORY_RECALL_SESSION_CHARACTER_LIMIT),
      filePath: "/mem/a.md",
      header: "Memory: /mem/a.md:",
      mtimeMs: 1,
      sizeBytes: 1,
    },
  ]);
  assert.equal(canStartMemoryRecall(state), false);
  assert.equal(state.recalledPaths.has("/mem/a.md"), true);
});

it("prefetch 只在 settled 后消费一次，并同步 read-state（offset 缺省、非 partial）", async () => {
  const root = await createMemoryDir({ "db.md": "---\nname: db\n---\nuse real db\n" });
  const fileSystem = createFileSystemPort();
  const { model, requests } = createRecordingModel({
    response: () => '{"selected_memories":["db.md"]}',
  });
  const runtime = createRecallRuntimeStub({
    entries: [userEntry("please apply the database policy", "real_user")],
    withMemory: { fileSystem, rootDir: root },
  });
  const recallRuntime = runtime as unknown as AgentRuntimeInternal;

  startProjectMemoryRecallPrefetch(
    recallRuntime,
    {
      model,
      traceContext: { traceId: "trace-recall" },
      turnAbortSignal: new AbortController().signal,
    },
    "semantic-recall",
  );
  const prefetch = runtime.memoryRecallPrefetch;
  assert.ok(prefetch);
  await waitFor(() => prefetch.settled);
  assert.equal(requests.length, 1, "selector 必须经当前同一 model 发起且只发一次");

  assert.equal(consumeSettledProjectMemoryRecall(recallRuntime, "default-index"), undefined);
  const entry = consumeSettledProjectMemoryRecall(recallRuntime, "semantic-recall");
  assert.ok(entry);
  assert.equal(entry.metadata.source, "relevant_memory");
  assert.match(String(entry.content), /use real db/u);
  assert.equal(consumeSettledProjectMemoryRecall(recallRuntime, "semantic-recall"), undefined);
  assert.equal(runtime.memoryRecallState.recalledPaths.size, 1);

  const staged = [...runtime.readFileState.values()][0];
  assert.equal(staged?.offset, undefined);
  assert.equal(staged?.isPartialView, false);
  assert.equal(staged?.path, join(root, "db.md"));
});

it("未 settled 的 prefetch 不消费；turn 结束 dispose 后不再注入", async () => {
  const root = await createMemoryDir({ "db.md": "db\n" });
  let releaseSelector: (() => void) | undefined;
  const slowModel = {
    ...createRecordingModel().model,
    generateText: async () => {
      await new Promise<void>((resolve) => {
        releaseSelector = resolve;
      });
      return {
        finishReason: "stop",
        text: '{"selected_memories":["db.md"]}',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  } as unknown as Model;
  const runtime = createRecallRuntimeStub({
    entries: [userEntry("please apply the database policy", "real_user")],
    withMemory: { fileSystem: createFileSystemPort(), rootDir: root },
  });
  const recallRuntime = runtime as unknown as AgentRuntimeInternal;

  startProjectMemoryRecallPrefetch(
    recallRuntime,
    {
      model: slowModel,
      traceContext: { traceId: "trace-recall-slow" },
      turnAbortSignal: new AbortController().signal,
    },
    "semantic-recall",
  );
  assert.equal(consumeSettledProjectMemoryRecall(recallRuntime, "semantic-recall"), undefined);
  disposeProjectMemoryRecallPrefetch(recallRuntime);
  assert.equal(runtime.memoryRecallPrefetch, undefined);
  releaseSelector?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(consumeSettledProjectMemoryRecall(recallRuntime, "semantic-recall"), undefined);
  assert.equal(runtime.readFileState.size, 0);
});

it("不支持 JsonSchemaOutput 的模型不启动 selector（不隐式换 provider）", () => {
  const { model, requests } = createRecordingModel({ supportsJsonSchemaOutput: false });
  const runtime = createRecallRuntimeStub({
    entries: [userEntry("please apply the database policy", "real_user")],
    withMemory: { fileSystem: createFileSystemPort(), rootDir: "/mem" },
  });
  startProjectMemoryRecallPrefetch(
    runtime as unknown as AgentRuntimeInternal,
    {
      model,
      traceContext: { traceId: "trace-no-schema" },
      turnAbortSignal: new AbortController().signal,
    },
    "semantic-recall",
  );
  assert.equal(runtime.memoryRecallPrefetch, undefined);
  assert.equal(requests.length, 0);
});

it("default-index 分支不启动 Recall", () => {
  const { model, requests } = createRecordingModel();
  const runtime = createRecallRuntimeStub({
    entries: [userEntry("please apply the database policy", "real_user")],
    withMemory: { fileSystem: createFileSystemPort(), rootDir: "/mem" },
  });
  startProjectMemoryRecallPrefetch(
    runtime as unknown as AgentRuntimeInternal,
    {
      model,
      traceContext: { traceId: "trace-default-branch" },
      turnAbortSignal: new AbortController().signal,
    },
    "default-index",
  );
  assert.equal(runtime.memoryRecallPrefetch, undefined);
  assert.equal(requests.length, 0);
});

it("reset 清空 session-local Recall 状态并 abort 未消费 prefetch", () => {
  const runtime = createRecallRuntimeStub();
  const abortController = new AbortController();
  let detached = false;
  runtime.memoryRecallState.manifest = [{ filePath: "/mem/a.md", filename: "a.md", mtimeMs: 1 }];
  runtime.memoryRecallState.recalledPaths.add("/mem/a.md");
  runtime.memoryRecallState.recalledContentCharacters = 42;
  runtime.memoryRecallPrefetch = {
    abortController,
    consumed: false,
    detachTurnAbort: () => {
      detached = true;
    },
    memories: [],
    settled: false,
  };

  resetProjectMemoryRecall(runtime as unknown as AgentRuntimeInternal);
  assert.equal(runtime.memoryRecallPrefetch, undefined);
  assert.equal(abortController.signal.aborted, true);
  assert.equal(detached, true);
  assert.deepEqual(runtime.memoryRecallState.recalledPaths, new Set());
  assert.equal(runtime.memoryRecallState.recalledContentCharacters, 0);
  assert.equal(runtime.memoryRecallState.manifest, undefined);
});

it("Dream 触达路径使 read-state、recalled path 与 manifest 失效", () => {
  const runtime = createRecallRuntimeStub();
  runtime.readFileState.set("/mem/a.md\u00001\u0000", {
    content: "old",
    isPartialView: false,
    path: "/mem/a.md",
    readAt: new Date(),
  });
  runtime.memoryRecallState.recalledPaths.add("/mem/a.md");
  runtime.memoryRecallState.manifest = [{ filePath: "/mem/a.md", filename: "a.md", mtimeMs: 1 }];
  runtime.memoryRecallState.selectorMessages = [{ content: "m", role: "user" }];

  invalidateProjectMemoryRecallPaths(runtime as unknown as AgentRuntimeInternal, ["/mem/a.md"]);
  assert.equal(runtime.readFileState.size, 0);
  assert.equal(runtime.memoryRecallState.recalledPaths.size, 0);
  assert.equal(runtime.memoryRecallState.manifest, undefined);
  assert.equal(runtime.memoryRecallState.selectorMessages, undefined);
});

it("Dream timing 先判 24h 最小间隔，再判 10min 扫描节流", () => {
  const nowMs = 100 * 86_400_000;
  assert.deepEqual(
    evaluateAutoDreamTiming({ lastConsolidatedAtMs: 0, lastScanAtMs: nowMs, nowMs }),
    { decision: "skip", reason: "scan-throttled" },
  );
  assert.deepEqual(
    evaluateAutoDreamTiming({
      lastConsolidatedAtMs: nowMs - 3_600_000,
      lastScanAtMs: nowMs - 3_600_000,
      nowMs,
    }),
    { decision: "skip", reason: "minimum-interval" },
  );
  assert.deepEqual(
    evaluateAutoDreamTiming({
      lastConsolidatedAtMs: nowMs - 25 * 3_600_000,
      lastScanAtMs: nowMs - 11 * 60_000,
      nowMs,
    }),
    { decision: "scan" },
  );
});

it("Dream lock：新鲜且 PID 存活时不认领；陈旧 lock 可接管", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-memory-dream-"));
  roots.push(root);
  const memoryRoot = join(root, "memory");
  await mkdir(memoryRoot, { recursive: true });
  const nowMs = Date.now();

  assert.equal(await acquireDreamLock({ memoryRoot, nowMs }), 0);
  const lockMtime = await readDreamLastConsolidatedAt(memoryRoot);
  assert.ok(lockMtime > 0 && lockMtime <= nowMs + 1_000);

  // 自己写入的 PID 新鲜且存活：本次不认领。
  assert.equal(await acquireDreamLock({ memoryRoot, nowMs: nowMs + 1_000 }), null);

  // 陈旧 lock（mtime 早于 1h）可接管，并返回旧 mtime 供失败回滚。
  const staleMtime = nowMs - 2 * 3_600_000;
  await writeFile(join(memoryRoot, ".consolidate-lock"), "999999", "utf8");
  await utimes(join(memoryRoot, ".consolidate-lock"), new Date(staleMtime), new Date(staleMtime));
  const prior = await acquireDreamLock({ memoryRoot, nowMs });
  assert.equal(Math.round(prior!), Math.round(staleMtime));
});

it("Dream lock 失败回滚：原本不存在则删除，原本存在则恢复空内容与原 mtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-memory-dream-restore-"));
  roots.push(root);
  const memoryRoot = join(root, "memory");
  await mkdir(memoryRoot, { recursive: true });
  // 认领先行成功才会回滚；没有 lock 时回滚不在生产路径上（与上游一致）。
  await writeFile(join(memoryRoot, ".consolidate-lock"), String(process.pid), "utf8");
  await restoreDreamLockAfterFailure({ memoryRoot, priorMtimeMs: 0 });
  assert.equal(await readDreamLastConsolidatedAt(memoryRoot), 0);

  const priorMtimeMs = Date.now() - 7_200_000;
  await writeFile(join(memoryRoot, ".consolidate-lock"), "owner", "utf8");
  await restoreDreamLockAfterFailure({ memoryRoot, priorMtimeMs });
  assert.equal(Math.round((await readDreamLastConsolidatedAt(memoryRoot)) / 1_000) * 1_000, Math.round(priorMtimeMs / 1_000) * 1_000);
});

it("Dream session 选择：有 workspaceIdentity 时只按 identity，否则按规范化目录", () => {
  const sessions = [
    {
      directory: "/workspace/project",
      id: "current",
      taskType: "interactive",
      workspaceID: "ssh://h/p",
    },
    { directory: "/workspace/project", id: "same-dir", taskType: "interactive" },
    {
      directory: "/workspace/project",
      id: "same-identity",
      taskType: "fork",
      workspaceID: "ssh://h/p",
    },
    {
      directory: "/workspace/project",
      id: "subagent",
      taskType: "subagent_child",
      workspaceID: "ssh://h/p",
    },
    { directory: "/elsewhere", id: "other", taskType: "interactive", workspaceID: "ssh://other/p" },
  ] as never;

  assert.deepEqual(
    selectProjectDreamSessions({
      currentSessionId: "current" as never,
      sessions,
      workspaceIdentity: " ssh://h/p ",
      workspacePath: "/workspace/project",
    }).map((session) => session.id),
    ["same-identity"],
  );
  assert.deepEqual(
    selectProjectDreamSessions({
      currentSessionId: "current" as never,
      sessions,
      workspacePath: "/workspace/project/",
    }).map((session) => session.id),
    // 无 identity 时只按规范化目录匹配，带 identity 的同目录会话也在候选内（与上游一致）。
    ["same-dir", "same-identity"],
  );
});

it("Dream 只记录 Memory 内 .md 的 Write/Edit 与窄 rm；越界路径不记录", () => {
  const paths = new Set<string>();
  const base = {
    rootDir: "/mem/memory",
    workingDirectory: "/workspace/project",
    workspaceRoot: "/workspace/project",
  };
  collectDreamTouchedPaths(paths, {
    ...base,
    toolCall: { id: "1", input: { file_path: "/mem/memory/fact.md" }, name: "Write" },
  });
  collectDreamTouchedPaths(paths, {
    ...base,
    toolCall: { id: "2", input: { file_path: "/workspace/other.md" }, name: "Edit" },
  });
  collectDreamTouchedPaths(paths, {
    ...base,
    toolCall: { id: "3", input: { command: "rm /mem/memory/old.md" }, name: "Bash" },
  });
  collectDreamTouchedPaths(paths, {
    ...base,
    toolCall: { id: "4", input: { command: "rm -rf /workspace/src" }, name: "Bash" },
  });
  collectDreamTouchedPaths(paths, {
    ...base,
    toolCall: { id: "5", input: { file_path: "/mem/memory/notes.txt" }, name: "Write" },
  });
  assert.deepEqual([...paths].sort(), ["/mem/memory/fact.md", "/mem/memory/old.md"]);
});

it("Dream prompt 固定四阶段与 transcript/consolidation 边界", () => {
  const prompt = buildMemoryDreamPrompt({
    memoryRoot: "/mem/memory",
    sessionIds: ["s1", "s2"],
    transcriptRoot: "/cli/rollout",
  });
  assert.match(prompt, /^# Dream: Memory Consolidation/u);
  for (const phase of ["Phase 1", "Phase 2", "Phase 3", "Phase 4"]) {
    assert.ok(prompt.includes(phase), `缺少 ${phase}`);
  }
  assert.match(prompt, /under 200 lines AND under ~25KB/u);
  assert.match(prompt, /Sessions since last consolidation \(2\)/u);
  assert.match(prompt, /- s1\n- s2/u);
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
