import type { KeyEvent } from "@mbears/opentui-core";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import {
  completeEffortCommand,
  completeModeCommand,
  completeModelCommand,
  completeSlashCommand,
} from "./app-keyboard-helpers.js";
import type {
  EffortCommandSelectionState,
  ModeCommandSelectionState,
  ModelCommandSelectionState,
  SlashCommand,
  SlashSelectionState,
} from "./app-model.js";
import type { TuiEffortOption, TuiModeOption, TuiModelOption } from "./types.js";

// Tab 只补全当前打开的候选列表，顺序固定为模型 → 力度 → 模式 → 斜杠命令；
// 补全后关闭对应候选集，避免下一次 Tab 继续追加。
export function handleTabCompletionKey(input: {
  consumeKey: (key: KeyEvent) => void;
  effortSelection: EffortCommandSelectionState | undefined;
  filteredEffortOptions: readonly TuiEffortOption[];
  filteredModeOptions: readonly TuiModeOption[];
  filteredModelOptions: readonly TuiModelOption[];
  filteredSlashCommands: readonly SlashCommand[];
  key: KeyEvent;
  modelSelection: ModelCommandSelectionState | undefined;
  modeSelection: ModeCommandSelectionState | undefined;
  setDraftValue: (value: string) => void;
  setEffortSelection: Dispatch<SetStateAction<EffortCommandSelectionState | undefined>>;
  setModelSelection: Dispatch<SetStateAction<ModelCommandSelectionState | undefined>>;
  setModeSelection: Dispatch<SetStateAction<ModeCommandSelectionState | undefined>>;
  setSlashSelection: Dispatch<SetStateAction<SlashSelectionState | undefined>>;
  slashSelection: SlashSelectionState | undefined;
}): boolean {
  if (input.key.name !== "tab") return false;
  const { consumeKey, setDraftValue } = input;
  consumeKey(input.key);
  if (completeModelCommand(input.filteredModelOptions, input.modelSelection, setDraftValue)) {
    input.setModelSelection(undefined);
    return true;
  }
  if (completeEffortCommand(input.filteredEffortOptions, input.effortSelection, setDraftValue)) {
    input.setEffortSelection(undefined);
    return true;
  }
  if (completeModeCommand(input.filteredModeOptions, input.modeSelection, setDraftValue)) {
    input.setModeSelection(undefined);
    return true;
  }
  if (completeSlashCommand(input.filteredSlashCommands, input.slashSelection, setDraftValue)) {
    input.setSlashSelection(undefined);
  }
  return true;
}

// Escape 从最内层候选集开始逐层关闭，全部关闭后才中止当前输出。
export function handleEscapeDismissalKey(input: {
  abortControllerRef: MutableRefObject<AbortController | undefined>;
  consumeKey: (key: KeyEvent) => void;
  effortSelection: EffortCommandSelectionState | undefined;
  key: KeyEvent;
  modelSelection: ModelCommandSelectionState | undefined;
  modeSelection: ModeCommandSelectionState | undefined;
  setEffortSelection: Dispatch<SetStateAction<EffortCommandSelectionState | undefined>>;
  setModelSelection: Dispatch<SetStateAction<ModelCommandSelectionState | undefined>>;
  setModeSelection: Dispatch<SetStateAction<ModeCommandSelectionState | undefined>>;
  setSlashSelection: Dispatch<SetStateAction<SlashSelectionState | undefined>>;
  setStatus: Dispatch<SetStateAction<string>>;
  slashSelection: SlashSelectionState | undefined;
  busy: boolean;
}): boolean {
  if (input.key.name !== "escape") return false;
  const { consumeKey, setStatus } = input;
  consumeKey(input.key);
  if (input.modelSelection) {
    input.setModelSelection(undefined);
    setStatus("Model suggestions dismissed.");
    return true;
  }
  if (input.effortSelection) {
    input.setEffortSelection(undefined);
    setStatus("Effort suggestions dismissed.");
    return true;
  }
  if (input.modeSelection) {
    input.setModeSelection(undefined);
    setStatus("Mode suggestions dismissed.");
    return true;
  }
  if (input.slashSelection) {
    input.setSlashSelection(undefined);
    setStatus("Slash suggestions dismissed.");
    return true;
  }
  if (input.busy) {
    input.abortControllerRef.current?.abort();
    setStatus("Pausing current output...");
    return true;
  }
  setStatus("No active output to pause. Press Ctrl-C twice to exit.");
  return true;
}
