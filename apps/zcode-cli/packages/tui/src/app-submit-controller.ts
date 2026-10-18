import React from "react";
import { isTuiQuitInput } from "./app-input.js";
import type { ModelSelection } from "@zcode/shared";
import type { SessionEvent, TurnId } from "@zcode/contracts";
import { submitDuringActiveTurn, submitIdleTurn } from "./app-submit.js";
import type {
  DraftAttachment,
  Message,
  QueuedInput,
  SelectionState,
  SubmitValueOptions,
  SlashSelectionState,
} from "./app-model.js";
import type { TuiOptions, TuiRequestPermission, TuiSubmitPromptResult } from "./types.js";

export function useSubmitValue(input: {
  activeTurnId?: TurnId;
  applyResult: (result: TuiSubmitPromptResult, preserveTurnState?: boolean) => void;
  applySessionEvent: (event: SessionEvent) => void;
  busy: boolean;
  draftAttachmentsRef: React.MutableRefObject<DraftAttachment[]>;
  emptyPromptStatus: string;
  messageInsertIndex: number;
  options: TuiOptions;
  requestPermission: TuiRequestPermission;
  resolveSubmittedText: (submittedValue: string) => string;
  resolveSubmittedModel?: (submittedValue: string) => ModelSelection | undefined;
  setBusy: (value: boolean) => void;
  setDraftAttachments: React.Dispatch<React.SetStateAction<DraftAttachment[]>>;
  setDraftValue: (value: string) => void;
  setLastError: (message: string | undefined) => void;
  setLiveModelText: (value: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setQueuedInputs: React.Dispatch<React.SetStateAction<QueuedInput[]>>;
  setSelection: React.Dispatch<React.SetStateAction<SelectionState | undefined>>;
  setSlashSelection: React.Dispatch<React.SetStateAction<SlashSelectionState | undefined>>;
  setStatus: (status: string) => void;
  setStatusDetails: React.Dispatch<React.SetStateAction<string[]>>;
  turnRef: React.MutableRefObject<AbortController | undefined>;
  requestExit: () => void;
  quitSummary: string;
}): (submittedValue: string, options?: SubmitValueOptions) => Promise<void> {
  return React.useCallback(
    async (submittedValue: string, options: SubmitValueOptions = {}) => {
      const hasAttachments = input.draftAttachmentsRef.current.length > 0;
      const quit = (value: string): boolean => {
        if (!isTuiQuitInput(value, hasAttachments)) return false;
        input.requestExit();
        return true;
      };
      // 原文和补全确认共用一次退出；多行粘贴不能因 resolver trim 而变成本地命令。
      if (quit(submittedValue)) return;
      const resolvedText = input.resolveSubmittedText(submittedValue).trim();
      const multiline = /[\r\n]/.test(submittedValue);
      // 旧补全状态不能把带附件/多行正文折叠成 /quit，继续保留原始业务输入。
      const text =
        resolvedText.toLowerCase() === "/quit" && (hasAttachments || multiline)
          ? submittedValue.trim()
          : resolvedText;
      if (!multiline && quit(text)) return;
      const modelSelection = input.resolveSubmittedModel?.(submittedValue);
      if (text.toLowerCase() === "/help quit" && !hasAttachments) {
        input.setDraftValue("");
        input.setStatus(`/quit — ${input.quitSummary}`);
        return;
      }
      const applyResult: typeof input.applyResult = (result, preserveTurnState) =>
        input.applyResult(
          text.toLowerCase() === "/help" && !hasAttachments
            ? { ...result, response: `${result.response}\n/quit — ${input.quitSummary}` }
            : result,
          preserveTurnState,
        );
      if (!text) {
        input.setStatus(input.emptyPromptStatus);
        return;
      }

      if (input.busy) {
        await submitDuringActiveTurn({
          activeTurnId: input.activeTurnId,
          applyResult,
          applySessionEvent: input.applySessionEvent,
          draftAttachments: input.draftAttachmentsRef.current,
          messageInsertIndex: input.messageInsertIndex,
          options: input.options,
          requestPermission: input.requestPermission,
          setDraftValue: input.setDraftValue,
          setLastError: input.setLastError,
          setMessages: input.setMessages,
          setQueuedInputs: input.setQueuedInputs,
          setStatus: input.setStatus,
          signal: input.turnRef.current?.signal,
          text,
          modelSelection,
        });
        return;
      }

      await submitIdleTurn({
        applyResult,
        applySessionEvent: input.applySessionEvent,
        draftAttachments: input.draftAttachmentsRef.current,
        options: input.options,
        requestPermission: input.requestPermission,
        setBusy: input.setBusy,
        setDraftAttachments: input.setDraftAttachments,
        setDraftValue: input.setDraftValue,
        setLastError: input.setLastError,
        setLiveModelText: input.setLiveModelText,
        setMessages: input.setMessages,
        setSelection: input.setSelection,
        setSlashSelection: input.setSlashSelection,
        setStatus: input.setStatus,
        setStatusDetails: input.setStatusDetails,
        submitOptions: options,
        text,
        modelSelection,
        turnRef: input.turnRef,
      });
    },
    [input],
  );
}
