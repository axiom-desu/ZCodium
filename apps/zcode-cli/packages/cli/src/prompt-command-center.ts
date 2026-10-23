// headless prompt 的 command-center 路由、自定义命令解析与 JSON/事件流输出判定；
// runPrompt 只保留提交编排，判定与路由由本模块唯一持有。
import { formatJson } from "@zcode/core";
import type { RunContext, GlobalOptions } from "@zcode/shared-types";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import { createCommandCenter } from "./command-center.js";
import type { CommandCenterApp, SlashCommand } from "./command-center.js";
import type { CliPermissionMode, ModeCapableApp, RunDependencies } from "./cli-types.js";

export const wantsJsonSummary = (options: GlobalOptions): boolean =>
  options.outputFormat === undefined
    ? options.json
    : options.outputFormat === "json" || options.outputFormat === "stream-json";

/** Does this run write each session event as it happens? */
export const wantsEventStream = (options: GlobalOptions): boolean =>
  options.outputFormat === "stream-json";

const TARGET_SELECTION_UNAVAILABLE_ERROR =
  "Headless goal commands cannot open an interactive replacement picker. Re-run with --target-replace or use /goal replace <objective>.";

const customCommandNotFoundPattern = /not found/i;

/** headless 下这条 slash 命令该走 command-center 而不是普通 prompt 路径吗？ */
export async function routesToPromptCommandCenter(
  slashCommand: SlashCommand,
  deps: RunDependencies,
): Promise<boolean> {
  if (slashCommand.type === "known") {
    return slashCommand.name === "expert" || slashCommand.name === "goal";
  }
  return !(await isResolvableCustomCommand(deps, slashCommand.rawName));
}

async function isResolvableCustomCommand(deps: RunDependencies, name: string): Promise<boolean> {
  // 保留名先问，再尝试加载——与 facade 那道 gate 的顺序逐字一致
  // （`bootstrap/src/custom-command-prompt.ts:31`）。判据必须是同一个：facade 对保留名
  // 直接返回 undefined、不做展开，所以这里若把一个保留名判成"可解析"，它就会以字面文本
  // `/compress …` 被当成普通 prompt 提交给模型——静默走错路，没有任何报错。
  //
  // 探测刻意用「保留名检查 + load」这一对，而不是直接调 resolveZCodeCustomCommandPrompt：
  // 后者会执行 `!` shell expansion，拿它探测等于把用户的 shell 片段跑两遍。
  // 这一对是它的无副作用等价物（load 只读文件）。
  if (await isReservedSlashCommandName(deps, name)) return false;
  try {
    await loadCustomCommandForPrompt(deps, name);
    return true;
  } catch (error) {
    // 只有"不存在"算不可解析（与 buildCustomCommandPrompt 同一判据）。读盘失败、
    // frontmatter 非法之类必须继续冒泡：把它们当成未知命令会用一句 "Unknown command"
    // 盖掉真正的失败原因。
    if (error instanceof Error && customCommandNotFoundPattern.test(error.message)) {
      return false;
    }
    throw error;
  }
}

async function isReservedSlashCommandName(deps: RunDependencies, name: string): Promise<boolean> {
  if (deps.isReservedSlashCommandName) return deps.isReservedSlashCommandName(name);
  const bootstrap = await loadBootstrapModule();
  return bootstrap.isReservedZCodeSlashCommandName(name);
}

export async function runPromptCommandCenterCommand(
  ctx: RunContext,
  options: GlobalOptions,
  app: ModeCapableApp,
  prompt: string,
  mode: CliPermissionMode | undefined,
  traceId: string | undefined,
  abortSignal: AbortSignal,
  deps: RunDependencies,
): Promise<number> {
  const commandCenter = createCommandCenter({
    getApp: async () => app as unknown as CommandCenterApp,
    getMode: () => app.getMode?.() ?? mode ?? "build",
    listCustomCommands: () => listCustomCommandsForPrompt(deps),
    loadCustomCommand: (name) => loadCustomCommandForPrompt(deps, name),
    recordInputHistory: async (input, kind) => {
      await app.recordInputHistory?.(input, kind);
    },
    resumeApp: async () => app as unknown as CommandCenterApp,
    setLocale: async (locale) => {
      if (!app.setLocale) {
        throw new Error("Locale switching is not available in this client.");
      }
      return await app.setLocale(locale);
    },
    setMode: async (nextMode) => {
      if (app.setMode) {
        const result = await app.setMode(nextMode);
        return result.mode;
      }
      app.runtime.updateConfig({ mode: nextMode });
      return nextMode;
    },
  });
  const result = await commandCenter(prompt, {
    abortSignal,
  });
  const nextTraceId = result.traceId ?? traceId;
  if (result.selection) {
    ctx.stderr.write(`Error: ${result.response}\n${TARGET_SELECTION_UNAVAILABLE_ERROR}\n`);
    return 1;
  }

  if (options.memoryBench) {
    await app.runtime.drainMemoryExtractions(null);
    abortSignal.throwIfAborted();
  }

  if (wantsJsonSummary(options)) {
    ctx.stdout.write(
      formatJson({
        sessionId: String(app.sessionId),
        ...(nextTraceId ? { traceId: nextTraceId } : {}),
        response: result.response,
      }),
    );
    return 0;
  }

  ctx.stdout.write(`${result.response}\n`);
  return 0;
}

export async function listCustomCommandsForPrompt(deps: RunDependencies) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  if (deps.listCustomCommands) {
    return await deps.listCustomCommands({ env, logger: deps.logger, workingDirectory });
  }
  const bootstrap = await loadBootstrapModule();
  return await bootstrap.listZCodeCustomCommands({ env, logger: deps.logger, workingDirectory });
}

async function loadCustomCommandForPrompt(deps: RunDependencies, name: string) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  if (deps.loadCustomCommand) {
    return await deps.loadCustomCommand({ env, logger: deps.logger, name, workingDirectory });
  }
  const bootstrap = await loadBootstrapModule();
  return await bootstrap.loadZCodeCustomCommand({
    env,
    logger: deps.logger,
    name,
    workingDirectory,
  });
}
