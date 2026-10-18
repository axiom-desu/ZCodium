import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { cpus } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const WARMUP_ITERATIONS = 15;
const SAMPLE_ITERATIONS = 100;
const ROW_COUNTS = [300, 1_500, 6_000, 12_000];
const SCENARIOS = ["no-plugin", "sparse-plugin", "shared-surface"];

function parseArgs(args) {
  const baselineIndex = args.indexOf("--baseline-root");
  if (baselineIndex === -1) return null;
  const root = args[baselineIndex + 1];
  if (!root || root.startsWith("--")) {
    throw new Error("--baseline-root requires a checkout root");
  }
  return resolve(root);
}

const baselineRoot = parseArgs(process.argv.slice(2));
const currentRoot = fileURLToPath(new URL("../..", import.meta.url));
const currentConfig = resolve(currentRoot, "packages/ui/tsconfig.json");
const currentModule = await tsImport("../../packages/ui/src/plugin-ui/index.ts", {
  parentURL: import.meta.url,
  tsconfig: currentConfig,
});
const { deriveLogicalUiInstances } = currentModule;

let deriveBaseline;
let baselineRevision;
if (baselineRoot) {
  const run = promisify(execFile);
  const { stdout } = await run("git", ["-C", baselineRoot, "rev-parse", "HEAD"]);
  baselineRevision = stdout.trim();
  // 确保报告的提交确实对应被测源码；node_modules 软链接不属于 tracked 源码。
  await run("git", [
    "-C",
    baselineRoot,
    "diff",
    "--exit-code",
    "HEAD",
    "--",
    "packages/ui/src/plugin-ui",
  ]);
  const baselineConfig = resolve(baselineRoot, "packages/ui/tsconfig.json");
  const baselineEntry = pathToFileURL(
    resolve(baselineRoot, "packages/ui/src/plugin-ui/index.ts"),
  ).href;
  const baselineModule = await tsImport(baselineEntry, {
    parentURL: import.meta.url,
    tsconfig: baselineConfig,
  });
  deriveBaseline = baselineModule.deriveLogicalUiInstances;
  if (typeof deriveBaseline !== "function") {
    throw new Error(`Baseline public entry has no deriveLogicalUiInstances: ${baselineEntry}`);
  }
  if (!deriveBaseline.toString().includes("turnOrder.includes")) {
    throw new Error("Baseline policy verification failed: expected old turnOrder.includes policy");
  }
  if (deriveLogicalUiInstances.toString().includes("turnOrder.includes")) {
    throw new Error("Current policy verification failed: unexpectedly contains turnOrder.includes");
  }
}

const { conversationRowSchema } = await tsImport("@zcode/shared/zcode-protocol-v4", {
  parentURL: import.meta.url,
  tsconfig: currentConfig,
});

function createRows(rowCount, scenario) {
  if (rowCount % 3 !== 0) throw new Error(`Expected row count divisible by 3: ${rowCount}`);
  const turnCount = rowCount / 3;
  const rows = [];

  for (let turnIndex = 0; turnIndex < turnCount; turnIndex += 1) {
    const turnId = `turn-${turnIndex}`;
    const rowId = turnIndex * 3;
    rows.push(
      {
        kind: "turnHeader",
        rowId,
        turnId,
        createdAt: turnIndex,
        createdAtSeq: rowId,
        origin: "userInput",
        state: "completedSuccess",
        startedAt: turnIndex,
      },
      {
        kind: "userInput",
        rowId: rowId + 1,
        turnId,
        createdAt: turnIndex,
        createdAtSeq: rowId + 1,
        origin: "realUser",
        text: `benchmark input ${turnIndex}`,
      },
      {
        kind: "assistantText",
        rowId: rowId + 2,
        turnId,
        createdAt: turnIndex,
        createdAtSeq: rowId + 2,
        state: "complete",
        text: `benchmark response ${turnIndex}`,
      },
    );
    const shouldAddPlugin =
      scenario === "shared-surface" ||
      (scenario === "sparse-plugin" && turnIndex === turnCount - 1);
    if (!shouldAddPlugin) continue;

    const toolCallId = `plugin-call-${turnIndex}`;
    // Replace the third row, preserving the original rowId and row ordering.
    rows[rows.length - 1] = {
      kind: "toolCall",
      rowId: rowId + 2,
      turnId,
      createdAt: turnIndex,
      createdAtSeq: rowId + 2,
      toolCallId,
      toolName: "mcp__benchmark__render",
      status: "success",
      inputText: "{}",
      display: {
        kind: "mcp_tool",
        serverName: "benchmark",
        toolName: "render",
        ui: {
          pluginId: "benchmark-plugin",
          resourceUri: "ui://benchmark/surface",
          surface: "shared-benchmark-surface",
        },
      },
    };
  }
  return rows;
}

function validateRows(rows) {
  for (const row of rows) {
    const parsed = conversationRowSchema.safeParse(row);
    if (!parsed.success) {
      throw new Error(`Invalid benchmark conversation row ${row.rowId}: ${parsed.error.message}`);
    }
  }
}

function assertResult(result, scenario, rowCount) {
  const expectedPluginRows =
    scenario === "shared-surface" ? rowCount / 3 : scenario === "sparse-plugin" ? 1 : 0;
  const expectedInstances = expectedPluginRows === 0 ? 0 : 1;
  if (result.instances.length !== expectedInstances) {
    throw new Error(
      `${scenario}/${rowCount}: expected ${expectedInstances} instances, got ${result.instances.length}`,
    );
  }
  const dispositionCount = Object.keys(result.byToolCallId).length;
  if (dispositionCount !== expectedPluginRows) {
    throw new Error(
      `${scenario}/${rowCount}: expected ${expectedPluginRows} row dispositions, got ${dispositionCount}`,
    );
  }
  if (expectedPluginRows > 0) {
    const instance = result.instances[0];
    const expectedActive = `plugin-call-${rowCount / 3 - 1}`;
    if (instance.activeToolCallId !== expectedActive) {
      throw new Error(
        `${scenario}/${rowCount}: expected active ${expectedActive}, got ${instance.activeToolCallId}`,
      );
    }
    const expectedSuperseded = scenario === "shared-surface" ? expectedPluginRows - 1 : 0;
    if (instance.supersededToolCallIds.length !== expectedSuperseded) {
      throw new Error(
        `${scenario}/${rowCount}: expected ${expectedSuperseded} superseded calls, got ${instance.supersededToolCallIds.length}`,
      );
    }
  }
}

function percentile(sortedSamples, value) {
  return sortedSamples[Math.ceil(value * sortedSamples.length) - 1];
}

function summarize(durationsMs) {
  durationsMs.sort((a, b) => a - b);
  return {
    p50Ms: percentile(durationsMs, 0.5),
    p95Ms: percentile(durationsMs, 0.95),
    maxMs: durationsMs.at(-1),
  };
}

function invokeTimed(derive, rows) {
  const start = process.hrtime.bigint();
  const result = derive(rows);
  return { result, elapsedMs: Number(process.hrtime.bigint() - start) / 1e6 };
}

function measure(rows, scenario, rowCount) {
  const currentDurations = [];
  const baselineDurations = [];
  if (!deriveBaseline) {
    for (let i = 0; i < WARMUP_ITERATIONS; i += 1) {
      assertResult(deriveLogicalUiInstances(rows), scenario, rowCount);
    }
    for (let i = 0; i < SAMPLE_ITERATIONS; i += 1) {
      const { result, elapsedMs } = invokeTimed(deriveLogicalUiInstances, rows);
      currentDurations.push(elapsedMs);
      assertResult(result, scenario, rowCount);
    }
  } else {
    for (let i = 0; i < WARMUP_ITERATIONS; i += 1) {
      const order =
        i % 2 === 0
          ? [
              [deriveLogicalUiInstances, "current"],
              [deriveBaseline, "baseline"],
            ]
          : [
              [deriveBaseline, "baseline"],
              [deriveLogicalUiInstances, "current"],
            ];
      for (const [derive] of order) assertResult(derive(rows), scenario, rowCount);
    }
    for (let i = 0; i < SAMPLE_ITERATIONS; i += 1) {
      const order =
        i % 2 === 0
          ? [
              [deriveLogicalUiInstances, currentDurations],
              [deriveBaseline, baselineDurations],
            ]
          : [
              [deriveBaseline, baselineDurations],
              [deriveLogicalUiInstances, currentDurations],
            ];
      const results = {};
      for (const [derive, durations] of order) {
        const timed = invokeTimed(derive, rows);
        durations.push(timed.elapsedMs);
        results[derive === deriveLogicalUiInstances ? "current" : "baseline"] = timed.result;
        assertResult(timed.result, scenario, rowCount);
      }
      if ((i + 1) % 25 === 0) assert.deepStrictEqual(results.current, results.baseline);
    }
  }

  return {
    type: "result",
    scenario,
    rows: rowCount,
    pluginRows: scenario === "shared-surface" ? rowCount / 3 : scenario === "sparse-plugin" ? 1 : 0,
    warmupIterations: WARMUP_ITERATIONS,
    sampleIterations: SAMPLE_ITERATIONS,
    ...summarize(currentDurations),
    ...(deriveBaseline ? { baseline: summarize(baselineDurations) } : {}),
  };
}

const cpu = cpus()[0];
console.log(
  JSON.stringify({
    type: "metadata",
    benchmark: "plugin-ui-instance-derivation",
    measurement: "pure derivation only; excludes Electron, React, and VSCode",
    schedule: deriveBaseline
      ? "paired alternating order; deep equality every 25 samples"
      : "single implementation",
    baselineRoot: baselineRoot ?? undefined,
    baselineRevision,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpu ? `${cpu.model} (${cpus().length} logical CPUs)` : "unknown",
    warmupIterations: WARMUP_ITERATIONS,
    sampleIterations: SAMPLE_ITERATIONS,
    rowCounts: ROW_COUNTS,
    scenarios: SCENARIOS,
  }),
);

for (const rowCount of ROW_COUNTS) {
  for (const scenario of SCENARIOS) {
    // Construct and schema-validate histories before any timed invocation.
    const rows = createRows(rowCount, scenario);
    validateRows(rows);
    console.log(JSON.stringify(measure(rows, scenario, rowCount)));
  }
}
