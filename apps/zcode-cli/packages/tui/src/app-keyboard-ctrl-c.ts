import type { KeyEvent } from "@mbears/opentui-core";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import {
  CTRL_C_EXIT_PROMPT,
  PROMPT_DRAFT_CLEARED_STATUS,
  resetCtrlCExitGuard,
  resolveCtrlCExitIntent,
  shouldClearPromptDraftOnCtrlC,
  type CtrlCExitGuard,
} from "./app-keyboard-helpers.js";
import type { DraftAttachment } from "./app-model.js";

// Ctrl-C 优先级：复制选区 → 清空草稿/附件 → 二次确认退出。返回 true 表示已处理。
// 单独一次 Ctrl-C 不再直接退出，避免长会话被误触关闭；状态守卫由调用方的 ref 保持。
export function handleComposerCtrlCKey(input: {
  abortControllerRef: MutableRefObject<AbortController | undefined>;
  consumeKey: (key: KeyEvent) => void;
  copyCurrentSelection: () => boolean;
  ctrlCExitGuard: CtrlCExitGuard;
  draftValue: string;
  key: KeyEvent;
  onExit: (code: number) => void;
  setDraftAttachments: Dispatch<SetStateAction<DraftAttachment[]>>;
  setDraftValue: (value: string) => void;
  setStatus: Dispatch<SetStateAction<string>>;
}): boolean {
  if (input.key.name !== "c" || !input.key.ctrl) return false;
  const { consumeKey, ctrlCExitGuard, setStatus } = input;
  consumeKey(input.key);
  if (input.copyCurrentSelection()) {
    resetCtrlCExitGuard(ctrlCExitGuard);
    return true;
  }

  if (shouldClearPromptDraftOnCtrlC(input.draftValue)) {
    resetCtrlCExitGuard(ctrlCExitGuard);
    input.setDraftValue("");
    input.setDraftAttachments([]);
    setStatus(PROMPT_DRAFT_CLEARED_STATUS);
    return true;
  }

  // A single Ctrl-C used to exit immediately, which made long sessions easy to lose.
  if (resolveCtrlCExitIntent(ctrlCExitGuard, Date.now()) === "confirm_exit") {
    input.abortControllerRef.current?.abort();
    input.onExit(0);
    return true;
  }

  setStatus(CTRL_C_EXIT_PROMPT);
  return true;
}
