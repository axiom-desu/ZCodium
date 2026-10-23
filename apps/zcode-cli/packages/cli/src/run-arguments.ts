// CLI 启动参数校验、归一化与 doctor 诊断：run.ts 只保留编排；校验文案与函数 arity 保持原样。
import { parseGlobalArgs } from "./arguments.js";
import { getRuntimeInfo, PresentationSurface } from "@zcode/core";
import { color, formatJson, supportsColor } from "@zcode/core";
import { getZCodeCopy, isUiLocale, UiLocale } from "@zcode/i18n";
import type { RunContext, GlobalOptions, GlobalOutputFormat } from "@zcode/shared-types";
import { formatCliHelp } from "./help.js";
import { CLI_COMMAND_NAME, CLI_PROCESS_NAME } from "./process-name.js";
import { PluginsCommandFlags } from "./plugins-command.js";
import { ToolSearchModeSchema, type ToolSearchMode } from "@zcode/contracts";
import type { CliPermissionMode, CliTargetRequest } from "./cli-types.js";

declare const __CLI_VERSION__: string | undefined;

export const version = typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "0.0.0";

const EMPTY_TARGET_ERROR = "--target requires non-empty text.";
export const DEFAULT_HEADLESS_PROMPT_MODE: CliPermissionMode = "yolo";
const FORCE_MCS_SCOPE_ERROR = "--force-mcs can only be used with --prompt, --target, or tui.";
const TOOL_SEARCH_MODE_INVALID_ERROR = "--toolsearch-mode must be one of auto, native, local, off.";

// 启动覆盖：缺省 off，非法值直接拒绝，不静默回退成 auto。
export const parseToolSearchMode = (
  values: ReturnType<typeof parseGlobalArgs>["values"],
): { toolSearchMode?: ToolSearchMode } | { error: string } => {
  const parsed = ToolSearchModeSchema.safeParse(values["toolsearch-mode"] ?? "off");
  return parsed.success
    ? parsed.data === "off"
      ? {}
      : { toolSearchMode: parsed.data }
    : { error: TOOL_SEARCH_MODE_INVALID_ERROR };
};

// --force-mcs 与 --toolsearch-mode 共用同一可支持调用面（prompt/target/tui）。
export const resolveRuntimeOverrideScopeError = (input: {
  forceMcs: boolean;
  toolSearchRequested: boolean;
  invocation: { positionals: string[]; prompt?: string; targetRequest?: CliTargetRequest };
}): string | undefined =>
  (!input.forceMcs && !input.toolSearchRequested) || isForceMcsSupportedInvocation(input.invocation)
    ? undefined
    : input.toolSearchRequested
      ? TOOL_SEARCH_MODE_SCOPE_ERROR
      : FORCE_MCS_SCOPE_ERROR;
const TOOL_SEARCH_MODE_SCOPE_ERROR =
  "--toolsearch-mode can only be used with --prompt, --target, or tui.";
const TARGET_REPLACE_REQUIRES_TARGET_ERROR = "--target-replace requires --target.";
export const TARGET_CONFLICTS_WITH_PROMPT_ERROR =
  '--target cannot be used with --prompt. Use either --target <objective> or --prompt "/goal <objective>".';
export const BROWSER_EXECUTABLE_REQUIRES_HEADLESS_ERROR =
  "--browser-executable requires --browser-use=headless.";
export const BROWSER_USE_SCOPE_ERROR =
  "--browser-use=headless can only be used with --prompt, --target, or tui.";
export const SURFACE_SCOPE_ERROR =
  "--surface can only be used with --prompt, --target, app-server, or agent-server.";
export const MEMORY_BENCH_SCOPE_ERROR = "--memory-bench can only be used with -p/--prompt.";
export const ENABLE_WORKFLOW_SCOPE_ERROR =
  "--enable-workflow can only be used with -p/--prompt or --target.";

export const pluginsCommandFlags = (
  values: ReturnType<typeof parseGlobalArgs>["values"],
): PluginsCommandFlags => ({
  ...(values.all === true ? { all: true } : {}),
  ...(values.available === true ? { available: true } : {}),
  ...(values["keep-data"] === true ? { keepData: true } : {}),
  ...(typeof values.scope === "string" ? { scope: values.scope } : {}),
  ...(Array.isArray(values.sparse) ? { sparse: values.sparse as string[] } : {}),
});

export const commandName = (positionals: string[]): string => positionals[0] ?? "tui";

export const isForceMcsSupportedInvocation = (input: {
  positionals: string[];
  prompt?: string;
  targetRequest?: CliTargetRequest;
}): boolean =>
  typeof input.prompt === "string" ||
  input.targetRequest !== undefined ||
  commandName(input.positionals) === "tui";

export const isPresentationSurfaceSupportedInvocation = (input: {
  positionals: string[];
  prompt?: string;
  targetRequest?: CliTargetRequest;
}): boolean => {
  const command = commandName(input.positionals);
  return (
    typeof input.prompt === "string" ||
    input.targetRequest !== undefined ||
    command === "app-server" ||
    command === "agent-server"
  );
};

export const globalOptions = (
  values: ReturnType<typeof parseGlobalArgs>["values"],
  locale: UiLocale | undefined,
  detectedLocale: GlobalOptions["detectedLocale"],
  browserUse: GlobalOptions["browserUse"],
  browserExecutable: GlobalOptions["browserExecutable"],
  outputFormat: GlobalOptions["outputFormat"],
): GlobalOptions => {
  return {
    browserExecutable,
    browserUse,
    detectedLocale,
    ...(values["enable-workflow"] === true ? { enableWorkflow: true } : {}),
    force: values.force === true,
    json: values.json === true,
    locale,
    ...(values["memory-bench"] === true ? { memoryBench: true } : {}),
    noColor: values["no-color"] === true,
    ...(outputFormat ? { outputFormat } : {}),
    ...parseToolSearchMode(values),
    verbose: values.verbose === true,
  };
};

const OUTPUT_FORMATS: readonly GlobalOutputFormat[] = ["text", "json", "stream-json"];

/**
 * Validate --output-format. Rejecting an unknown value matters more than it
 * looks: a caller that misspells it would otherwise get plain text back and
 * silently parse nothing.
 */
export const normalizeOutputFormat = (
  value: string | undefined,
): GlobalOutputFormat | undefined => {
  if (value === undefined) return undefined;
  if ((OUTPUT_FORMATS as readonly string[]).includes(value)) return value as GlobalOutputFormat;
  throw new Error(
    `--output-format must be one of ${OUTPUT_FORMATS.join(", ")} (received: ${value}).`,
  );
};

export const normalizeLocaleOption = (value: string | undefined): UiLocale | undefined => {
  if (value === undefined) return undefined;
  if (isUiLocale(value)) return value;
  throw new Error(getZCodeCopy().cli.errors.localeUnsupported(value));
};

export const normalizePromptMode = (value: string | undefined): CliPermissionMode | undefined => {
  if (value === undefined) return undefined;
  const mode = value.toLowerCase();
  if (mode === "build" || mode === "plan" || mode === "edit" || mode === "yolo") return mode;
  throw new Error(`Unsupported --mode value: ${value}. Supported modes: build, edit, plan, yolo.`);
};

export const normalizeBrowserUse = (value: string | undefined): GlobalOptions["browserUse"] => {
  if (value === undefined) return undefined;
  if (value.toLowerCase() === "headless") return "headless";
  throw new Error(`Unsupported --browser-use value: ${value}. Supported value: headless.`);
};

export const normalizePresentationSurface = (value: string | undefined): PresentationSurface => {
  if (value === undefined || value.toLowerCase() === "terminal") return "terminal";
  if (value.toLowerCase() === "desktop") return "zcode_desktop";
  throw new Error(`Unsupported --surface value: ${value}. Supported surfaces: terminal, desktop.`);
};

export const normalizeTargetRequest = (
  values: ReturnType<typeof parseGlobalArgs>["values"],
): CliTargetRequest | undefined => {
  const rawTarget = values.target as string | undefined;
  const replaceExisting = values["target-replace"] === true;
  if (rawTarget === undefined) {
    if (replaceExisting) {
      throw new Error(TARGET_REPLACE_REQUIRES_TARGET_ERROR);
    }
    return undefined;
  }

  const objective = rawTarget.trim();
  if (objective.length === 0) {
    throw new Error(EMPTY_TARGET_ERROR);
  }

  return {
    objective,
    replaceExisting,
  };
};

export const buildHeadlessTargetCommand = (targetRequest: CliTargetRequest): string =>
  targetRequest.replaceExisting
    ? `/goal replace ${targetRequest.objective}`
    : `/goal ${targetRequest.objective}`;

export const writeHelp = (
  stdout: NodeJS.WriteStream,
  locale?: UiLocale,
  detectedLocale?: GlobalOptions["detectedLocale"],
): void => {
  stdout.write(formatCliHelp(version, locale, detectedLocale));
};

export const runDoctor = (
  ctx: RunContext,
  options: GlobalOptions,
  workingDirectory: string,
): number => {
  const runtime = getRuntimeInfo();
  const payload = {
    cli: {
      name: CLI_COMMAND_NAME,
      processName: CLI_PROCESS_NAME,
      version,
    },
    runtime: {
      arch: runtime.arch,
      cwd: workingDirectory,
      execPath: runtime.execPath,
      node: runtime.node,
      platform: runtime.platform,
      processTitle: process.title,
      sea: runtime.sea,
    },
    packaging: {
      default: "node-bundle",
      sea: "optional",
    },
  };

  if (options.json) {
    ctx.stdout.write(formatJson(payload));
    return 0;
  }

  const colors = supportsColor(ctx.stdout, options.noColor);
  ctx.stdout.write(`${color.bold("zcode doctor", colors)}\n`);
  ctx.stdout.write(`version: ${payload.cli.version}\n`);
  ctx.stdout.write(`process: ${payload.runtime.processTitle}\n`);
  ctx.stdout.write(`node: ${payload.runtime.node}\n`);
  ctx.stdout.write(`platform: ${payload.runtime.platform}/${payload.runtime.arch}\n`);
  ctx.stdout.write(`sea: ${payload.runtime.sea ? "yes" : "no"} (${payload.packaging.sea})\n`);
  ctx.stdout.write(`default artifact: ${payload.packaging.default}\n`);

  if (options.verbose) {
    ctx.stdout.write(`execPath: ${payload.runtime.execPath}\n`);
    ctx.stdout.write(`cwd: ${payload.runtime.cwd}\n`);
  }

  return 0;
};
