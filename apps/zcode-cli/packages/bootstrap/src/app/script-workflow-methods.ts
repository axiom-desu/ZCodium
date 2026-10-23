import type { SubmitPromptOptions, ZCodeApp } from "./types.js";
import {
  ScriptWorkflowRuntime,
  type ScriptWorkflowRuntimeDeps,
} from "./script-workflow-runtime.js";
import { createScriptWorkflowToolPort } from "./script-workflow-tool-port.js";

type ScriptWorkflowFacade = Pick<
  ZCodeApp,
  | "listScriptWorkflows"
  | "resumeWorkflowScript"
  | "runWorkflowScript"
  | "scriptWorkflowStatus"
  | "validateWorkflowScript"
>;

interface ScriptWorkflowBridge extends ScriptWorkflowFacade {
  workflowPort: ReturnType<typeof createScriptWorkflowToolPort>;
}

type ScriptWorkflowBridgeDeps = Omit<ScriptWorkflowRuntimeDeps, "runtime"> & {
  getRuntime: () => ScriptWorkflowRuntimeDeps["runtime"];
};

type ScriptWorkflowRuntimeOptions = Pick<SubmitPromptOptions, "abortSignal" | "traceContext"> & {
  onEvent?: (event: unknown) => void | Promise<void>;
};

export function createScriptWorkflowBridge(deps: ScriptWorkflowBridgeDeps): ScriptWorkflowBridge {
  let runtime: ScriptWorkflowRuntime | undefined;
  const getRuntime = () => {
    runtime ??= new ScriptWorkflowRuntime({ ...deps, runtime: deps.getRuntime() });
    return runtime;
  };
  return {
    listScriptWorkflows: (input) => getRuntime().list(input),
    resumeWorkflowScript: (input, options) => getRuntime().resume(input, toRuntimeOptions(options)),
    runWorkflowScript: (input, options) => getRuntime().run(input, toRuntimeOptions(options)),
    scriptWorkflowStatus: (input) => getRuntime().status(input),
    validateWorkflowScript: (input) => getRuntime().validate(input),
    workflowPort: createScriptWorkflowToolPort({
      fileSystemPort: deps.fileSystemPort,
      getRuntime,
      logger: deps.logger,
      sessionId: deps.sessionId,
      sessionStore: deps.sessionStore,
      storageRoot: deps.storageRoot,
      traceContext: deps.traceContext,
      workingDirectory: deps.workingDirectory,
    }),
  };
}

function toRuntimeOptions(
  options: Parameters<NonNullable<ZCodeApp["runWorkflowScript"]>>[1],
): ScriptWorkflowRuntimeOptions | undefined {
  if (!options) return undefined;
  return {
    abortSignal: options.abortSignal,
    onEvent: options.onEvent as ((event: unknown) => void | Promise<void>) | undefined,
    traceContext: options.traceContext,
  };
}
