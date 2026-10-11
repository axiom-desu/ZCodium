// ============================================================
// dwf run 的发起锚点
// ============================================================
// 子代理的 agent_step 要归到「发起这次 run 的那一轮」下面。锚点是一个 inputId，
// 零 SQL 地活在 journal 事件 `run-launched` 里（只在建 run 那一世记一次）：
//   - 提交时由本文件解析出来（活动轮 / 直接启动铸的值 / 前驱 run 的锚点 / 兜底铸值）
//     交给引擎落库；
//   - resume 与进度事件派生字段从 journal 读回，同一个 run 的锚点因此跨生命周期唯一。
//
// 同一条事件还捎着三件同规的宿主元数据：脚本声明的阶段表（`phaseNames`）、本 run 子代理的
// 选型（`subagentModel`）与脚本来自哪个文件（`scriptPath`）。四者都只在建 run 那一世写一次、引擎一概不读、都零 SQL——`dwf_run` 上
// 没有对应的列。

import type { TraceContext } from "@zcode/contracts";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import { uuidv7 } from "@zcode/shared";

export interface RunLaunchAnchor {
  /** 发起 run 那一轮的 inputId（中枢直接启动为铸出的 UUID v7）。 */
  inputId: string;
}

/**
 * 交给引擎记进 `run-launched` 的全部内容：锚点 + 脚本声明的阶段表 + 本 run 子代理的选型（`subagentModel`，规范 picker 串
 * `providerId/modelId[$reasoningLevel]`）。
 *
 * 后两者**都不是**锚点的一部分：修订续跑沿用前驱的 inputId，却用新脚本的阶段表，也绝不沿用
 * 前驱的模型（「省略即沿用前驱」是工具面的三态，由 AmendWorkflow 的 resolveInput 归一）——
 * 所以它们在 submit 里与锚点并列合入，而不是塞进 {@link resolveLaunchAnchor}。
 */
export interface RunLaunch extends RunLaunchAnchor {
  phaseNames?: string[];
  subagentModel?: string;
  /**
   * 本 run 脚本文件的绝对路径。与阶段表、
   * 子代理选型同规地不属于锚点：修订记的是**这一次修订**的脚本来自哪个文件，绝不沿用前驱的。
   */
  scriptPath?: string;
  /** 与 `phaseNames` 按位置对齐的「同时在跑」表（下标指向同一张表）；同样只在建 run 那一世落 journal。 */
  phaseAlongside?: number[][];
  /** `phaseNames` 里哪些下标是**未补全的留白**（侧栏据此画虚线站）；无留白时缺席。 */
  holes?: number[];
}

/**
 * 从 journal 读回 run 的锚点：首条 `run-launched`。升级前发起的 run 没有这条事件 → `undefined`，
 * 调用方据此不派生 `launchInputId`（事实层随之不发 `workflow.lifecycle`，子代理不上报，不补造）。
 *
 * 锚点紧跟首条 `run-started`（引擎的记录顺序），所以只读 journal 的头几条，不把整条 journal
 * 读进内存；`RUN_LAUNCH_ANCHOR_SCAN_LIMIT` 留出余量以防将来在它前面再插入建 run 事件。
 */
const RUN_LAUNCH_ANCHOR_SCAN_LIMIT = 8;

export function readRunLaunchAnchor(
  journal: JournalStorePort,
  runId: string,
): RunLaunchAnchor | undefined {
  for (const stored of journal.listEvents(runId, { limit: RUN_LAUNCH_ANCHOR_SCAN_LIMIT })) {
    if (stored.event.type === "run-launched") return { inputId: stored.event.inputId };
  }
  return undefined;
}

/**
 * 从 journal 读回本 run 子代理的选型：同一条 `run-launched` 上的 `subagentModel`。resume、两条读面与冷回放都据此还原同一个规范串——
 * 零 SQL，`dwf_run` 上没有这一列。缺席即子代理跑在会话模型上（绝大多数 run，升级前发起的
 * run 亦然）。
 *
 * 与锚点同一条扫描、同一个上限，却**刻意不挂在** {@link RunLaunchAnchor} 上：
 * {@link resolveLaunchAnchor} 会让修订续跑沿用前驱的锚点，而模型绝不能这样被继承——那是
 * 工具面的三态（省略 = 沿用前驱、null = 回到会话模型、串 = 设定），归一发生在
 * `AmendWorkflow` 的 resolveInput 里，与 `max_concurrency` 同一条论证。
 */
export function readRunSubagentModel(journal: JournalStorePort, runId: string): string | undefined {
  for (const stored of journal.listEvents(runId, { limit: RUN_LAUNCH_ANCHOR_SCAN_LIMIT })) {
    if (stored.event.type === "run-launched") return stored.event.subagentModel;
  }
  return undefined;
}

/**
 * 从 journal 读回本 run 的脚本文件：同一条 `run-launched` 上的 `scriptPath`。两条读面的冷路径据此
 * 还原同一个绝对路径——零 SQL，`dwf_run` 上没有这一列。缺席即这个 run 没有可编辑的脚本文件
 * （草稿写不下去的项目、本特性之前发起的 run）。
 *
 * 与 {@link readRunSubagentModel} 同一条扫描、同一个上限，同样**刻意不挂在**
 * {@link RunLaunchAnchor} 上：锚点会被修订续跑沿用，而前驱的脚本路径指向的是旧脚本，
 * 沿用它就是让模型下次去编辑一个已经不在跑的文件。
 */
export function readRunScriptPath(journal: JournalStorePort, runId: string): string | undefined {
  for (const stored of journal.listEvents(runId, { limit: RUN_LAUNCH_ANCHOR_SCAN_LIMIT })) {
    if (stored.event.type === "run-launched") return stored.event.scriptPath;
  }
  return undefined;
}

/**
 * 提交时解析锚点。优先级：
 *   1. 修订续跑（`resume_from`）沿用**前驱**的锚点——同一件工作的所有 step 挂同一个 message；
 *   2. 调用方显式给的 `launchInputId`（中枢直接启动：与 controlOnly 启动轮共用一个 UUID v7）；
 *   3. 父 runtime 活动轮的 inputId（聊天 CreateWorkflow：工具在那一轮里执行）；
 *   4. 兜底铸一个 UUID v7（CLI、无活动轮的宿主、前驱没有锚点的修订）。
 */
export function resolveLaunchAnchor(input: {
  requested?: string;
  trace: TraceContext;
  resolveLaunchInputId?: (trace: TraceContext) => string | undefined;
  predecessor?: RunLaunchAnchor;
  mint?: () => string;
}): RunLaunchAnchor {
  if (input.predecessor !== undefined) return input.predecessor;
  const inputId =
    input.requested ?? input.resolveLaunchInputId?.(input.trace) ?? (input.mint ?? uuidv7)();
  return { inputId };
}
