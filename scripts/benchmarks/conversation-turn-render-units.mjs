#!/usr/bin/env node
// Builder-only synthetic benchmark: not an Electron measurement; the builder still scans O(N) rows.
// No VS Code benchmark is included or implied. No application or real conversation data is loaded.
import assert from "node:assert/strict";
import os from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { tsImport } from "tsx/esm/api";

const root = resolve(import.meta.dirname, "../..");
const uiTsconfig = resolve(root, "packages/ui/tsconfig.json");
const { buildConversationTurnRenderUnits } = await tsImport(
  resolve(root, "packages/ui/src/v4/conversationTurnRenderUnits.ts"),
  { parentURL: import.meta.url, tsconfig: uiTsconfig },
);
const { ConversationTurnRenderUnitCache } = await tsImport(
  resolve(root, "packages/ui/src/v4/conversationTurnRenderUnitCache.ts"),
  { parentURL: import.meta.url, tsconfig: uiTsconfig },
);

const WARMUP = 15;
const SAMPLES = 100;
const ROW_COUNTS = [300, 1500, 6000, 12000];

function makeRows(rowCount) {
  const rows = [];
  const turnCount = rowCount / 3;
  for (let index = 0; index < turnCount; index += 1) {
    const turnId = `turn-${index}`;
    const base = { turnId, createdAt: index * 1000, createdAtSeq: index * 3 };
    const running = index === turnCount - 1;
    rows.push(
      {
        ...base,
        kind: "turnHeader",
        rowId: index * 3,
        origin: "userInput",
        state: running ? "running" : "completedSuccess",
        startedAt: index * 1000,
        ...(running ? {} : { endedAt: index * 1000 + 500 }),
      },
      {
        ...base,
        kind: "userInput",
        rowId: index * 3 + 1,
        origin: "realUser",
        text: `question ${index}`,
      },
      {
        ...base,
        kind: "assistantText",
        rowId: index * 3 + 2,
        state: running ? "streaming" : "complete",
        text: `answer ${index}`,
      },
    );
  }
  return rows;
}

function cloneWithTailDelta(rows, iteration) {
  const next = rows.slice();
  const last = next.length - 1;
  next[last] = { ...next[last], text: `${next[last].text}!${iteration}` };
  return next;
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50Ms: Number(percentile(sorted, 0.5).toFixed(4)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(4)),
    maxMs: Number(sorted.at(-1).toFixed(4)),
  };
}

function createRunner(rowCount, strategy, scenario) {
  const cache = strategy === "warm-cache" ? new ConversationTurnRenderUnitCache() : undefined;
  let rows = makeRows(rowCount);
  let nowMs = 1_000_000;
  return {
    advance() {
      if (scenario === "tail-delta") rows = cloneWithTailDelta(rows, ++nowMs);
      else nowMs += 1000;
    },
    measure() {
      const started = performance.now();
      const result = buildConversationTurnRenderUnits(rows, { nowMs }, cache);
      return { result, elapsed: performance.now() - started };
    },
  };
}

function runPair(rowCount, scenario) {
  // Independent runners preserve separate rows, clock, and cache while following equivalent timelines.
  const uncached = createRunner(rowCount, "uncached", scenario);
  const warmCache = createRunner(rowCount, "warm-cache", scenario);
  for (let i = 0; i < WARMUP; i += 1) {
    uncached.advance();
    warmCache.advance();
    const runners = i % 2 === 0 ? [uncached, warmCache] : [warmCache, uncached];
    for (const runner of runners) runner.measure();
  }

  const uncachedSamples = [];
  const warmCacheSamples = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    // Update both inputs before timing so only the builder is included in each measurement.
    uncached.advance();
    warmCache.advance();
    const results = {};
    const runners = i % 2 === 0 ? ["uncached", "warmCache"] : ["warmCache", "uncached"];
    for (const name of runners) {
      const measured = (name === "uncached" ? uncached : warmCache).measure();
      results[name] = measured.result;
      (name === "uncached" ? uncachedSamples : warmCacheSamples).push(measured.elapsed);
    }
    if ((i + 1) % 25 === 0) {
      assert.deepStrictEqual(
        results.uncached,
        results.warmCache,
        `${scenario}: cached and uncached output differs at sample ${i + 1}`,
      );
    }
  }
  return { uncached: stats(uncachedSamples), warmCache: stats(warmCacheSamples) };
}

const cpus = os.cpus();
console.log(
  JSON.stringify({
    type: "metadata",
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus[0]?.model ?? "unknown",
    logicalCpus: cpus.length,
    warmupIterations: WARMUP,
    measuredIterations: SAMPLES,
    schedule:
      "paired alternating order: uncached first on even samples, warm cache first on odd samples",
    note: "Synthetic builder-only benchmark; not Electron/whole-window or VS Code performance.",
  }),
);

for (const rowCount of ROW_COUNTS) {
  for (const scenario of ["tail-delta", "timer-tick"]) {
    const { uncached, warmCache } = runPair(rowCount, scenario);
    console.log(
      JSON.stringify({
        type: "result",
        rowCount,
        scenario,
        uncached,
        warmCache,
        speedupP50: Number((uncached.p50Ms / warmCache.p50Ms).toFixed(3)),
      }),
    );
  }
}
