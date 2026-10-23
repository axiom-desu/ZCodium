import { safeLogArgs, safeDiagnosticFrames } from "@zcode/shared";
import { extractDisallowedToolsArgs, parseGlobalArgs } from "./arguments.js";
import { createNodeLoggerFactory } from "@zcode/adapters";
import { createDiagnosticsExporter } from "@zcode/shared/node";
import { PresentationSurface } from "@zcode/core";
import { UiLocale } from "@zcode/i18n";
import type { RunContext, GlobalOptions } from "@zcode/shared-types";
import {
  applyCliRuntimeEnvSanitization,
  loadCliDotenv,
  prepareCliRuntimeEnv,
  shouldLoadCliDotenvForProtocolServer,
} from "./env.js";
import { runHooksCommand } from "./hooks-trust-command.js";
import { detectCliLocale } from "./locale.js";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import { runEmbeddedSearchCli } from "./internal-search/embedded-search-cli.js";
import { runCommandsCommand } from "./commands-command.js";
import { resolveCliCwd } from "./cwd.js";
import {
  isRetiredAccountCommand,
  retiredAccountCommandResponse,
} from "./retired-account-command.js";
import { isPluginHostInvocation, runPluginHostCommand } from "./plugin-host-command.js";
import { isDwfChildInvocation, runDwfChildCommand } from "./dwf-child-command.js";
import { runPrompt } from "./prompt-command.js";
import { runPluginsCommand } from "./plugins-command.js";
import { runSkillsCommand } from "./skills-command.js";
import { runTuiCommand } from "./tui-command.js";
import type {
  CliPermissionMode,
  CliResumeRequest,
  CliTargetRequest,
  RunDependencies,
} from "./cli-types.js";

// 保持拆分前 run.js 的公开 re-export，外部仍可从入口拿到 RunDependencies。
export type { RunDependencies } from "./cli-types.js";
import {
  version,
  DEFAULT_HEADLESS_PROMPT_MODE,
  TARGET_CONFLICTS_WITH_PROMPT_ERROR,
  BROWSER_EXECUTABLE_REQUIRES_HEADLESS_ERROR,
  BROWSER_USE_SCOPE_ERROR,
  SURFACE_SCOPE_ERROR,
  MEMORY_BENCH_SCOPE_ERROR,
  ENABLE_WORKFLOW_SCOPE_ERROR,
  pluginsCommandFlags,
  commandName,
  isForceMcsSupportedInvocation,
  parseToolSearchMode,
  resolveRuntimeOverrideScopeError,
  isPresentationSurfaceSupportedInvocation,
  globalOptions,
  normalizeOutputFormat,
  normalizeLocaleOption,
  normalizePromptMode,
  normalizeBrowserUse,
  normalizePresentationSurface,
  normalizeTargetRequest,
  buildHeadlessTargetCommand,
  writeHelp,
  runDoctor,
} from "./run-arguments.js";

const runZCodeProtocolCommand = async (
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
  presentationSurface: PresentationSurface,
  prepareStorageOnly = false,
): Promise<number> => {
  try {
    const env = prepareCliRuntimeEnv(deps.env ?? process.env);
    const workingDirectory = (deps.cwd ?? process.cwd)();
    // 打包态 app-server 是 desktop host 的内部协议子进程。
    // 如果这里继续从 workspace 向上读取用户 .env，读文件失败或环境污染会在协议建立前
    // 直接退出，外层只能看到 ZCode agent transport closed。
    const dotenvResult = shouldLoadCliDotenvForProtocolServer(env)
      ? (deps.loadDotenv ?? loadCliDotenv)({
          cwd: workingDirectory,
          env,
        })
      : {
          keys: [],
          loaded: false,
        };
    applyCliRuntimeEnvSanitization(env);

    if (dotenvResult.error) {
      throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
        cause: dotenvResult.error,
      });
    }

    const runProtocolAgent =
      deps.runZCodeProtocolAgent ?? (await loadBootstrapModule()).runZCodeProtocolAgent;
    await runProtocolAgent({
      lifecycle: deps.protocolLifecycle,
      cwd: workingDirectory,
      env,
      input: deps.protocolInput ?? ctx.stdin,
      output: ctx.stdout,
      presentationSurface,
      prepareStorageOnly,
      version,
    });
    return 0;
  } catch (error) {
    const message = JSON.stringify(safeLogArgs([error]));
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${safeDiagnosticFrames(error.stack).join("\n")}\n`);
    }
    return 1;
  }
};

export const run = async (ctx: RunContext, deps: RunDependencies = {}): Promise<number> => {
  if (ctx.argv[0] === "__internal-search") {
    return runEmbeddedSearchCli(ctx.argv.slice(1), {
      cwd: (deps.cwd ?? process.cwd)(),
      stderr: ctx.stderr,
      stdin: ctx.stdin,
      stdout: ctx.stdout,
    });
  }

  if (isPluginHostInvocation(ctx.argv)) {
    return await runPluginHostCommand(ctx, ctx.argv.slice(1));
  }

  // 与 plugin host 同理，且必须同样在 parseArgs 之前：SEA 下 dwf 的沙箱子进程是本二进制的
  // 自 re-exec，argv 末位是入口文件路径——交给严格 parseArgs 只会报未知参数。
  if (isDwfChildInvocation(ctx.argv)) {
    return await runDwfChildCommand(ctx, ctx.argv.slice(1));
  }

  if (ctx.argv[0] === "hooks") {
    return await runHooksCommand(ctx, deps, version);
  }

  let parsed: ReturnType<typeof parseGlobalArgs>;
  let toolDisallowlist: readonly string[] | undefined;

  try {
    const extracted = extractDisallowedToolsArgs(ctx.argv);
    parsed = parseGlobalArgs(extracted.args);
    toolDisallowlist = extracted.toolDisallowlist;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n\n`);
    writeHelp(ctx.stderr);
    return 1;
  }

  let locale: UiLocale | undefined;
  try {
    locale = normalizeLocaleOption(parsed.values.locale as string | undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }

  if (isRetiredAccountCommand(commandName(parsed.positionals))) {
    ctx.stderr.write(`${retiredAccountCommandResponse(locale)}\n`);
    return 1;
  }

  let mode: CliPermissionMode | undefined;
  let browserUse: GlobalOptions["browserUse"];
  let presentationSurface: PresentationSurface;
  try {
    mode = normalizePromptMode(parsed.values.mode as string | undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }

  try {
    browserUse = normalizeBrowserUse(parsed.values["browser-use"] as string | undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }
  try {
    presentationSurface = normalizePresentationSurface(parsed.values.surface as string | undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }
  const browserExecutable = parsed.values["browser-executable"] as string | undefined;
  if (browserExecutable !== undefined && browserUse !== "headless") {
    ctx.stderr.write(`${BROWSER_EXECUTABLE_REQUIRES_HEADLESS_ERROR}\n`);
    return 1;
  }

  const resumeRequest: CliResumeRequest = {
    continueSession: parsed.values.continue === true,
    resumeSessionId: parsed.values.resume as string | undefined,
  };
  if (resumeRequest.continueSession && resumeRequest.resumeSessionId) {
    ctx.stderr.write("--resume and --continue cannot be used together.\n");
    return 1;
  }

  const env = prepareCliRuntimeEnv(deps.env ?? process.env);
  const detectedLocale = detectCliLocale(env);
  let outputFormat: GlobalOptions["outputFormat"];
  try {
    outputFormat = normalizeOutputFormat(parsed.values["output-format"] as string | undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }
  const options = globalOptions(
    parsed.values,
    locale,
    detectedLocale,
    browserUse,
    browserExecutable,
    outputFormat,
  );
  const parsedToolSearchMode = parseToolSearchMode(parsed.values);
  if ("error" in parsedToolSearchMode)
    return (ctx.stderr.write(`${parsedToolSearchMode.error}\n`), 1);
  const toolSearchMode = parsedToolSearchMode.toolSearchMode ?? "off";
  const forceMcs = parsed.values["force-mcs"] === true;
  let targetRequest: CliTargetRequest | undefined;
  try {
    targetRequest = normalizeTargetRequest(parsed.values);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }

  if (targetRequest && typeof parsed.values.prompt === "string") {
    ctx.stderr.write(`${TARGET_CONFLICTS_WITH_PROMPT_ERROR}\n`);
    return 1;
  }

  if (
    parsed.values.surface !== undefined &&
    !isPresentationSurfaceSupportedInvocation({
      positionals: parsed.positionals,
      prompt: parsed.values.prompt as string | undefined,
      targetRequest,
    })
  ) {
    ctx.stderr.write(`${SURFACE_SCOPE_ERROR}\n`);
    return 1;
  }

  if (parsed.values.help === true) {
    writeHelp(ctx.stdout, options.locale, options.detectedLocale);
    return 0;
  }

  if (parsed.values.version === true) {
    ctx.stdout.write(`${version}\n`);
    return 0;
  }

  if (
    options.enableWorkflow &&
    (parsed.positionals.length > 0 ||
      (typeof parsed.values.prompt !== "string" && targetRequest === undefined))
  ) {
    ctx.stderr.write(`${ENABLE_WORKFLOW_SCOPE_ERROR}\n`);
    return 1;
  }

  if (
    options.memoryBench &&
    (typeof parsed.values.prompt !== "string" || parsed.positionals.length > 0)
  ) {
    ctx.stderr.write(`${MEMORY_BENCH_SCOPE_ERROR}\n`);
    return 1;
  }

  if (
    browserUse === "headless" &&
    !isForceMcsSupportedInvocation({
      positionals: parsed.positionals,
      prompt: parsed.values.prompt as string | undefined,
      targetRequest,
    })
  ) {
    ctx.stderr.write(`${BROWSER_USE_SCOPE_ERROR}\n`);
    return 1;
  }

  const overrideScopeError = resolveRuntimeOverrideScopeError({
    forceMcs,
    invocation: {
      positionals: parsed.positionals,
      prompt: parsed.values.prompt as string | undefined,
      targetRequest,
    },
    toolSearchRequested: parsed.values["toolsearch-mode"] !== undefined,
  });
  if (overrideScopeError) {
    ctx.stderr.write(`${overrideScopeError}\n`);
    return 1;
  }

  let workingDirectory: string;
  try {
    workingDirectory = resolveCliCwd({
      cwd: deps.cwd ?? process.cwd,
      requestedCwd: parsed.values.cwd as string | undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }

  // 协议进程只向 Main 的安全 IPC 通道发送诊断；独立 CLI 才拥有可选出口。
  const protocolMode = ["agent-server", "app-server"].includes(commandName(parsed.positionals));
  const diagnostics = protocolMode ? undefined : createDiagnosticsExporter({ env });
  const loggerFactory = createNodeLoggerFactory({
    env,
    onDiagnostic: (record) => diagnostics?.record(record),
  });
  try {
    const commandDeps: RunDependencies = {
      ...deps,
      cwd: () => workingDirectory,
      env,
      logger: deps.logger ?? loggerFactory.createLogger("zcode").child({ module: "cli" }),
      loggerFactory: deps.loggerFactory ?? loggerFactory,
      loadDotenv: (dotenvOptions = {}) => {
        const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)(dotenvOptions);
        applyCliRuntimeEnvSanitization(dotenvOptions.env ?? env);
        return dotenvResult;
      },
    };

    if (typeof parsed.values.prompt === "string") {
      return await runPrompt(
        ctx,
        parsed.values.prompt,
        parsed.values.attach ?? [],
        options,
        commandDeps,
        version,
        mode ?? DEFAULT_HEADLESS_PROMPT_MODE,
        resumeRequest,
        toolDisallowlist,
        forceMcs,
        presentationSurface,
      );
    }

    if (targetRequest) {
      return await runPrompt(
        ctx,
        buildHeadlessTargetCommand(targetRequest),
        [],
        options,
        commandDeps,
        version,
        mode,
        resumeRequest,
        toolDisallowlist,
        forceMcs,
        presentationSurface,
      );
    }

    switch (commandName(parsed.positionals)) {
      case "help":
        writeHelp(ctx.stdout, options.locale, options.detectedLocale);
        return 0;
      case "version":
        ctx.stdout.write(`${version}\n`);
        return 0;
      case "agent-server":
      case "app-server":
        return await runZCodeProtocolCommand(
          ctx,
          options,
          commandDeps,
          presentationSurface,
          parsed.values["prepare-storage"] === true,
        );
      case "doctor":
        return runDoctor(ctx, options, workingDirectory);
      case "commands":
        return await runCommandsCommand(ctx, options, commandDeps, parsed.positionals.slice(1));
      case "plugin":
      case "plugins":
        return await runPluginsCommand(
          ctx,
          options,
          commandDeps,
          parsed.positionals.slice(1),
          pluginsCommandFlags(parsed.values),
        );
      case "skills":
        return await runSkillsCommand(ctx, options, commandDeps, parsed.positionals.slice(1));
      case "tui":
        return await runTuiCommand(
          ctx,
          options,
          commandDeps,
          version,
          mode,
          resumeRequest,
          toolDisallowlist,
          forceMcs,
          toolSearchMode,
        );
      default:
        ctx.stderr.write(`Unknown command: ${commandName(parsed.positionals)}\n\n`);
        writeHelp(ctx.stderr, options.locale, options.detectedLocale);
        return 1;
    }
  } finally {
    await loggerFactory.flush();
    await diagnostics?.shutdown();
  }
};
