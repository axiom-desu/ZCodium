import { getZCodeCopy } from "@zcode/i18n";
import { createSelectionState } from "./app-selection-state.js";
import { appendAgentResult } from "./app-submit.js";
import type { Message, SelectionState } from "./app-model.js";
import type { TuiOptions } from "./types.js";

// 启动快照形状只在 createTuiInitialState 内部消费，不作为模块对外导出的契约。
type TuiInitialState = {
  messages: Message[];
  mode: NonNullable<TuiOptions["initialMode"]>;
  model: string;
  thoughtLevel: string;
  locale: NonNullable<TuiOptions["locale"]>;
  modelSetupRequired: boolean;
  status: string;
  selection: SelectionState | undefined;
  effortOptions: NonNullable<TuiOptions["effortOptions"]>;
};

// 启动快照只在这里解析一次：CLI 传入的 initialResult 优先于 options 的静态默认值，
// 状态文案跟随 locale，避免首帧出现与模型配置不一致的 readiness 提示。
export function createTuiInitialState(options: TuiOptions): TuiInitialState {
  // Startup sentinels are diagnostics, not user-visible transcript messages.
  const initialResult = options.initialResult;
  const locale = options.locale ?? "en-US";
  const copy = getZCodeCopy(locale);
  const modelSetupRequired =
    initialResult?.modelSetupRequired ?? options.modelSetupRequired ?? false;

  return {
    messages: initialResult
      ? appendAgentResult([], initialResult, { workspaceDirectory: options.workspaceDirectory })
      : [],
    mode: initialResult?.mode ?? options.initialMode ?? "build",
    model: initialResult?.model ?? options.initialModel ?? "unknown",
    thoughtLevel: initialResult?.thoughtLevel ?? options.initialThoughtLevel ?? "",
    locale,
    modelSetupRequired,
    status:
      initialResult?.selection?.prompt ??
      (modelSetupRequired ? copy.tui.modelSetupRequired.status : copy.tui.status.ready),
    selection: createSelectionState(initialResult?.selection),
    effortOptions: initialResult?.effortOptions ?? options.effortOptions ?? [],
  };
}
