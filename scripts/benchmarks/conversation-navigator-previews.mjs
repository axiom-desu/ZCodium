#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const root = resolve(import.meta.dirname, "../..");
const baselineArg = process.argv.find((arg) => arg.startsWith("--baseline-root="));
const baselineRootArgIndex = process.argv.indexOf("--baseline-root");
const baselineRoot =
  baselineArg?.slice("--baseline-root=".length) ??
  (baselineRootArgIndex >= 0 ? process.argv[baselineRootArgIndex + 1] : undefined);
const WARMUP_SAMPLES = 15;
const MEASURED_SAMPLES = 100;
const TURN_COUNTS = [100, 500, 2000];
const ASSISTANT_TEXT = "Navigator benchmark assistant content. ".repeat(128).slice(0, 4096);
const BASE_TIME = 1_735_689_600_000;
const OPTIONS = {
  assistantEmptyPreview: "No assistant response",
  assistantRunningPreview: "Working",
  userFallbackPreview: "Empty query",
  maxPreviewChars: 220,
  maxPreviewParagraphs: 2,
};

function git(rootPath, ...args) {
  return execFileSync("git", ["-C", rootPath, ...args], { encoding: "utf8" }).trim();
}

function gitRevision(rootPath) {
  return git(rootPath, "rev-parse", "HEAD");
}

function ensureCleanGitCheckout(rootPath) {
  const status = git(rootPath, "status", "--porcelain");
  assert.equal(status, "", `Baseline checkout must be clean: ${rootPath}\n${status}`);
}

const { conversationRowSchema } = await tsImport("@zcode/shared/zcode-protocol-v4", {
  parentURL: import.meta.url,
  tsconfig: resolve(root, "packages/ui/tsconfig.json"),
});
const uiTsconfig = resolve(root, "packages/ui/tsconfig.json");
const helperRelativePath = "packages/ui/src/v4/conversationTurnNavigatorHelpers.ts";
const currentModule = await tsImport(pathToFileURL(resolve(root, helperRelativePath)).href, {
  parentURL: import.meta.url,
  tsconfig: uiTsconfig,
});
assert.equal(typeof currentModule.buildConversationTurnNavigatorItems, "function");
const currentCacheModule = await tsImport(
  pathToFileURL(resolve(root, "packages/ui/src/v4/conversationTurnNavigatorPreviewCache.ts")).href,
  { parentURL: import.meta.url, tsconfig: uiTsconfig },
);
assert.equal(typeof currentCacheModule.ConversationTurnNavigatorPreviewCache, "function");

let baselineModule;
let baselineRevision;
if (baselineRoot) {
  const absoluteBaselineRoot = resolve(baselineRoot);
  ensureCleanGitCheckout(absoluteBaselineRoot);
  baselineRevision = gitRevision(absoluteBaselineRoot);
  const baselineHelperPath = resolve(absoluteBaselineRoot, helperRelativePath);
  baselineModule = await tsImport(pathToFileURL(baselineHelperPath).href, {
    parentURL: import.meta.url,
    tsconfig: resolve(absoluteBaselineRoot, "packages/ui/tsconfig.json"),
  });
  assert.equal(typeof baselineModule.buildConversationTurnNavigatorItems, "function");
}

function validatedRows(count) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const turnId = `benchmark-turn-${index}`;
    const base = {
      turnId,
      createdAt: BASE_TIME,
      createdAtSeq: index * 3,
    };
    const isLastTurn = index === count - 1;
    rows.push(
      {
        ...base,
        rowId: index * 3,
        kind: "turnHeader",
        origin: "userInput",
        state: isLastTurn ? "running" : "completedSuccess",
        startedAt: BASE_TIME,
        ...(!isLastTurn ? { endedAt: BASE_TIME + 1_000, activeMs: 1_000 } : {}),
      },
      {
        ...base,
        rowId: index * 3 + 1,
        createdAtSeq: index * 3 + 1,
        kind: "userInput",
        text: `Synthetic query ${index}`,
        origin: "realUser",
      },
      {
        ...base,
        rowId: index * 3 + 2,
        createdAtSeq: index * 3 + 2,
        kind: "assistantText",
        text: ASSISTANT_TEXT,
        state: isLastTurn ? "streaming" : "complete",
      },
    );
  }
  // 验证完整初始快照只做一次；streaming 更新只校验被替换的末尾行。
  return rows.map((row) => conversationRowSchema.parse(row));
}

function replaceTailAssistantRow(rows, generation) {
  const tailAssistantIndex = rows.length - 1;
  const previous = rows[tailAssistantIndex];
  rows[tailAssistantIndex] = conversationRowSchema.parse({
    ...previous,
    text: `${ASSISTANT_TEXT.slice(0, -1)}${generation % 10}`,
  });
}

function makeUnits(rows, nowMs) {
  return buildUnits(rows, { nowMs, sessionPhase: "active" });
}

const { buildConversationTurnRenderUnits: buildUnits } = await tsImport(
  pathToFileURL(resolve(root, "packages/ui/src/v4/conversationTurnRenderUnits.ts")).href,
  { parentURL: import.meta.url, tsconfig: uiTsconfig },
);

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1),
    samples: samples.length,
  };
}

function runTimed(module, units, options, cache) {
  const started = performance.now();
  const result = module.buildConversationTurnNavigatorItems(units, options, cache);
  const elapsed = performance.now() - started;
  return { elapsed, result };
}

function callPair({ currentCache, units, options, sampleIndex }) {
  let currentResult;
  let baselineResult;
  let currentElapsed;
  let baselineElapsed;
  const callCurrentFirst = sampleIndex % 2 === 0;
  const callCurrent = () => {
    const measured = runTimed(currentModule, units, options, currentCache);
    currentResult = measured.result;
    currentElapsed = measured.elapsed;
  };
  const callBaseline = () => {
    const measured = runTimed(baselineModule, units, options);
    baselineResult = measured.result;
    baselineElapsed = measured.elapsed;
  };
  if (callCurrentFirst) {
    callCurrent();
    if (baselineModule) callBaseline();
  } else {
    if (baselineModule) callBaseline();
    callCurrent();
  }
  return { currentResult, baselineResult, currentElapsed, baselineElapsed };
}

function makeState(caseName, rows, sampleIndex) {
  // Source mutation and render-unit projection happen before timing; both implementations
  // receive these exact units. Tail-delta replaces only the streaming assistant row.
  if (caseName === "tail-delta") replaceTailAssistantRow(rows, sampleIndex + 1);
  const nowMs = BASE_TIME + sampleIndex * 1_000;
  const units = makeUnits(rows, nowMs);
  return { rows, units, nowMs };
}

const metadata = {
  type: "metadata",
  benchmark: "conversation-navigator-previews",
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cpu: os.cpus()[0]?.model ?? "unknown",
  logicalCpus: os.cpus().length,
  currentRevision: gitRevision(root),
  currentHelperDirty: git(root, "status", "--porcelain", "--", helperRelativePath) !== "",
  baselineRevision: baselineRevision ?? null,
  baselineRoot: baselineRoot ? resolve(baselineRoot) : null,
  helper: helperRelativePath,
  warmupSamples: WARMUP_SAMPLES,
  measuredSamples: MEASURED_SAMPLES,
  assistantTextBytes: Buffer.byteLength(ASSISTANT_TEXT),
};
console.log(JSON.stringify(metadata));

for (const turnCount of TURN_COUNTS) {
  for (const caseName of ["cold", "tail-delta", "timer-tick"]) {
    const currentCache =
      caseName === "cold"
        ? undefined
        : new currentCacheModule.ConversationTurnNavigatorPreviewCache();
    const currentTimes = [];
    const baselineTimes = [];
    let previousResult;
    const totalSamples = WARMUP_SAMPLES + MEASURED_SAMPLES;
    const rows = validatedRows(turnCount);

    for (let sampleIndex = 0; sampleIndex < totalSamples; sampleIndex += 1) {
      const state = makeState(caseName, rows, sampleIndex);
      const pair = callPair({
        currentCache:
          caseName === "cold"
            ? new currentCacheModule.ConversationTurnNavigatorPreviewCache()
            : currentCache,
        units: state.units,
        options: OPTIONS,
        sampleIndex,
      });
      assert.equal(pair.currentResult.length, turnCount, `${caseName} expected ${turnCount} items`);
      const finalItem = pair.currentResult.at(-1);
      assert.equal(finalItem.unitIndex, turnCount - 1, `${caseName} final unit index mismatch`);
      assert.equal(
        finalItem.rowId,
        (turnCount - 1) * 3 + 1,
        `${caseName} final query row ID mismatch`,
      );
      if (sampleIndex % 25 === 0) {
        assert.equal(rows.at(-1).rowId, turnCount * 3 - 1, `${caseName} tail row ID mismatch`);
      }
      if (baselineModule) {
        assert.equal(pair.baselineResult.length, turnCount, "baseline item count mismatch");
        if (sampleIndex % 25 === 0) assert.deepEqual(pair.currentResult, pair.baselineResult);
      }
      if (caseName === "timer-tick" && previousResult && sampleIndex % 25 === 0) {
        assert.deepEqual(pair.currentResult, previousResult);
      }
      previousResult = pair.currentResult;

      if (sampleIndex >= WARMUP_SAMPLES) {
        currentTimes.push(pair.currentElapsed);
        if (baselineModule) baselineTimes.push(pair.baselineElapsed);
      }
    }

    const record = {
      type: "result",
      case: caseName,
      turns: turnCount,
      items: turnCount,
      current: summarize(currentTimes),
      ...(baselineModule ? { baseline: summarize(baselineTimes) } : {}),
    };
    console.log(JSON.stringify(record));
  }
}
