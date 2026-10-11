// ============================================================
// Dynamic Workflow Run Service：给一处正在等的留白补上函数体
// ============================================================
// 引擎文档「Holes」→「The fill service's checks」。这是 `DynamicWorkflowRunPort.fillHole` 的
// 实现体，与 `retuneConcurrency` 同一姿态：它一个 run 都不铸，只对着已经在飞的那个说一句话。
//
// 顺序就是全部的语义，且**拒绝即零副作用**（留白照旧在等）：
//   1. 找 run（journal 行 ∪ 注册表）→ `run_not_found`；不在本进程飞 → `hole_not_waiting`；
//   2. 读 run 此刻的脚本，收集站点表，按站点 id 找到那处开放的留白 → 不在 / 已补 → `hole_not_waiting`；
//   3. 把函数体拼成调用的最后一个实参（`spliceHoleBody`），对**整份**有效脚本跑一遍与提交同款的
//      分析 → `compile_failed`（带 diagnostics，草稿不动）；
//   4. 站点稳定性复核（`checkSiteStability`）：老 id 一个不少、位置只按插入行数平移，新 id 全是这次
//      补全写下的 → 不成立是宿主故障 → `fill_ids_unstable`；
//   5. 经控制面把 `holeBodies[siteId]`、有效脚本与它的规格表 / 阶段表交给引擎（`fillHole` 一个
//      同步步骤里写回 run 行、记 `hole-filled`、放行停驻的分支）→ `not_waiting` / `settled` →
//      `hole_not_waiting`；
//   6. 引擎收下之后才动宿主侧：注册表条目换成有效脚本的事实，草稿**就地**改写。草稿写失败不撤销
//      补全——journal 已经是真相，草稿只是把手。

import { writeFile } from "node:fs/promises";
import type { DynamicWorkflowRunFillHoleRequest, FillWorkflowHoleResult } from "@zcode/contracts";
import {
  analyzeWorkflowScript,
  checkSiteStability,
  collectSites,
  createWorkflowProgram,
  spliceHoleBody,
} from "@zcode/dynamic-workflow";
import { compileProgram, collectSitePhasesOf, phaseNamesOfFlow } from "./dynamic-workflow-run-compile.js";
import { mapFillDiagnostics, openHoleIndexes } from "./dynamic-workflow-run-holes.js";
import type { RunRegistryEntry } from "./dynamic-workflow-run-observation.js";
import type { DynamicWorkflowRunServiceDeps } from "./dynamic-workflow-run-service.js";

export interface DynamicWorkflowRunFillContext {
  deps: DynamicWorkflowRunServiceDeps;
  runs: Map<string, RunRegistryEntry>;
  /** 每个 run 的补全串行链：runId → 该 run 最后一次排进去的补全。链排空即删键。 */
  fillQueues: Map<string, Promise<unknown>>;
}

type Refusal = Extract<FillWorkflowHoleResult, { ok: false }>;

function refuse(reason: Refusal["reason"], message: string): Refusal {
  return { ok: false, reason, message };
}

/**
 * 同一个 run 的补全**串行**执行：一个 run 可以同时停在两处留白，模型也会把两次 FillWorkflowHole
 * 放进同一个并行批里；本函数从读 `entry.scriptText` 到把有效脚本交给引擎之间有 await，第二次调用
 * 就会拿**第一次补全之前**的文本去拼，引擎的 `updateRunScript` 随后把第一个函数体整个盖掉。所以
 * 每次补全都排在该 run 上一次补全**完全返回**之后才开始，并在自己的轮到时才读脚本；上一次被拒绝
 * （甚至抛错）不阻塞下一次。不同 run 之间互不排队。
 */
export function fillDynamicWorkflowHole(
  ctx: DynamicWorkflowRunFillContext,
  request: DynamicWorkflowRunFillHoleRequest,
): Promise<FillWorkflowHoleResult> {
  const { runId } = request;
  const previous = ctx.fillQueues.get(runId) ?? Promise.resolve();
  const turn = previous.then(
    () => fillOnce(ctx, request),
    () => fillOnce(ctx, request),
  );
  const settled: Promise<unknown> = turn.then(
    () => undefined,
    () => undefined,
  );
  ctx.fillQueues.set(runId, settled);
  void settled.then(() => {
    if (ctx.fillQueues.get(runId) === settled) ctx.fillQueues.delete(runId);
  });
  return turn;
}

async function fillOnce(
  ctx: DynamicWorkflowRunFillContext,
  request: DynamicWorkflowRunFillHoleRequest,
): Promise<FillWorkflowHoleResult> {
  const { deps, runs } = ctx;
  const { runId, holeId } = request;
  const entry = runs.get(runId);
  const record = deps.journal.getRun(runId);
  if (entry === undefined && record === undefined) {
    return refuse("run_not_found", `No run with id ${runId}.`);
  }
  // 在飞判定看**本进程注册表**：journal 说 running 而这里没有它，是别的进程（或死进程）的 run，
  // 本 service 够不着它的引擎。停下的 run 指向 ResumeWorkflowRun。
  if (entry === undefined || entry.terminal !== undefined || entry.control === undefined) {
    const status = entry?.terminal?.status ?? record?.status;
    const hint =
      status === "stopped"
        ? `Run ${runId} is stopped; ResumeWorkflowRun it first, after which the hole asks again.`
        : status === "completed" || status === "errored"
          ? `Run ${runId} has ended (${status}); nothing is waiting.`
          : `Run ${runId} is not in flight in this session.`;
    return refuse("hole_not_waiting", hint);
  }

  // 2. run 此刻的脚本（条目上的就是引擎手里的那份：一次补全会同步换掉它）。在自己轮到时才读——
  //    排在前面的补全已经把它换成了带那个函数体的有效脚本。
  const scriptText = entry.scriptText;
  const workflow = createWorkflowProgram(scriptText);
  const before = collectSites(workflow);
  const site = before.holes.find((hole) => hole.id === holeId);
  if (site === undefined) {
    const known = before.holes.map((hole) => `${hole.id} (${hole.name ?? "?"})`).join(", ");
    return refuse(
      "hole_not_waiting",
      `${holeId} is not a hole of run ${runId}${known === "" ? "" : `; its holes are ${known}`}.`,
    );
  }
  if (site.body !== undefined) {
    return refuse("hole_not_waiting", `${holeId} of run ${runId} is already filled.`);
  }

  // 3. 拼接 + 与提交同款的分析（9012 与其余 authoring 规则都在里面）。
  const spliced = spliceHoleBody(scriptText, before, holeId, request.body);
  if (spliced === undefined) {
    return refuse("hole_not_waiting", `${holeId} of run ${runId} cannot take a body.`);
  }
  const analysis = analyzeWorkflowScript(spliced.text);
  if (!analysis.ok) {
    return {
      ok: false,
      reason: "compile_failed",
      message: `The effective script does not compile (${analysis.diagnostics.length} diagnostic${
        analysis.diagnostics.length === 1 ? "" : "s"
      }); nothing was spliced and the hole is still waiting.`,
      diagnostics: mapFillDiagnostics({
        diagnostics: analysis.diagnostics,
        effectiveText: spliced.text,
        body: request.body,
        insertedAtLine: spliced.insertedAtLine,
        insertedLines: spliced.insertedLines,
      }),
    };
  }

  // 4. 稳定性复核在编译产物之前：编译（schema 合成、lowering）对一份 id 会错位的脚本是白付。
  const effective = createWorkflowProgram(spliced.text);
  const after = collectSites(effective);
  const stability = checkSiteStability(
    before,
    after,
    holeId,
    spliced.insertedAtLine,
    spliced.insertedLines,
  );
  if (!stability.ok) {
    deps.logger?.error?.("Dynamic workflow hole fill renumbered an existing site", undefined, {
      detail: stability.detail,
      event: "dynamic_workflow.fill.ids_unstable",
      holeId,
      module: "bootstrap.app",
      runId,
    });
    return refuse(
      "fill_ids_unstable",
      `The compiled effective script renumbered an existing site (${stability.detail}). This is a host fault, not a problem with the body; the hole is still waiting.`,
    );
  }

  const compiled = compileProgram(spliced.text, effective, after);
  const code = compiled.holeBodies[holeId];
  if (code === undefined) {
    // 拼接成功、稳定性通过，lowering 却没给出这处留白的函数体：只可能是分析器与 lowering 的
    // 契约漂移。按宿主故障报，而不是把 undefined 递给引擎。
    return refuse(
      "fill_ids_unstable",
      `Lowering produced no body for ${holeId}; this is a host fault and the hole is still waiting.`,
    );
  }

  // 有效脚本的阶段表：控制流投影里有名阶段的名字（留白按名字占位），开放留白下标由它算。
  const phaseNames = phaseNamesOfFlow(analysis.flow);
  const holeIndexes = openHoleIndexes(phaseNames, compiled.holes);
  // 站点 → 词法出生阶段：与提交同一条投影（`collectSitePhases` 的宿主等价物）。
  const sitePhases =
    analysis.core === undefined ? new Map<string, string>() : collectSitePhasesOf(analysis.core);

  // 5. 交给引擎（一个同步步骤：换表、写回有效脚本、记 hole-filled、放行停驻的分支）。
  const filledBy =
    request.parentSessionId === undefined ? {} : { filledBy: String(request.parentSessionId) };
  const result = entry.control.fillHole({
    siteId: holeId,
    code,
    script: { text: spliced.text, hash: compiled.scriptHash },
    askSpecs: compiled.askSpecs,
    sitePhases,
    phaseNames,
    ...(holeIndexes === undefined ? {} : { holes: holeIndexes }),
    ...filledBy,
  });
  if (result === undefined || !result.ok) {
    const reason = result?.reason;
    deps.logger?.info?.("Dynamic workflow hole fill refused by the engine", {
      event: "dynamic_workflow.fill.refused",
      holeId,
      module: "bootstrap.app",
      reason: reason ?? "engine_unbound",
      runId,
    });
    return refuse(
      "hole_not_waiting",
      reason === "settled"
        ? `Run ${runId} has already settled; nothing is waiting.`
        : `Run ${runId} is not waiting at ${holeId}: it has not reached it yet, or it is already filled.`,
    );
  }

  // 6. 引擎收下了：宿主侧的事实跟着换（脚本、留白表、阶段表描述的必须是同一份脚本），再写草稿。
  const previousPhases = new Set(entry.phaseNames ?? []);
  entry.scriptText = spliced.text;
  entry.holes = compiled.holes;
  entry.phaseNames = phaseNames;
  await rewriteDraft(ctx, entry, runId, spliced.text);
  const scriptPath = entry.scriptPath;
  deps.logger?.info?.("Dynamic workflow hole filled", {
    event: "dynamic_workflow.fill.applied",
    holeId,
    module: "bootstrap.app",
    runId,
    ...(scriptPath === undefined ? {} : { scriptPath }),
  });
  return {
    ok: true,
    phasesAdded: phaseNames.filter((name) => !previousPhases.has(name)),
    ...(scriptPath === undefined ? {} : { scriptPath }),
    scriptText: spliced.text,
  };
}

/**
 * 草稿的就地改写：run 有草稿就改写那个文件、路径不变——这是「草稿绝不在模型背后被覆盖」的唯一
 * 例外，模型要的正是这次写入。尽力而为：写不进去只记一条 warn，路径照旧。
 */
async function rewriteDraft(
  ctx: DynamicWorkflowRunFillContext,
  entry: RunRegistryEntry,
  runId: string,
  text: string,
): Promise<void> {
  if (entry.scriptPath === undefined) return;
  try {
    await writeFile(entry.scriptPath, text, "utf8");
  } catch (error) {
    ctx.deps.logger?.warn?.("Dynamic workflow draft could not be rewritten after a fill", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "dynamic_workflow.fill.draft_rewrite_failed",
      module: "bootstrap.app",
      runId,
      scriptPath: entry.scriptPath,
    });
  }
}
