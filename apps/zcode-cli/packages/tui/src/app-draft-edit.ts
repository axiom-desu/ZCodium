import { useCallback, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { syncTextareaValue, type PromptInputEditor } from "./app-input-pane.js";
import { reconcileSlashSelection } from "./app-input.js";
import type { DraftAttachment, SlashCommand, SlashSelectionState } from "./app-model.js";
import type { useEffortCommandController } from "./app-effort-command.js";
import type { useModeCommandController } from "./app-mode-command.js";
import type { useModelCommandController } from "./app-model-command.js";

// 草稿写入口只负责「文本 + 附件 + 历史游标 + 编辑器同步」这一组本地状态；
// 候选集协调保持原有排他优先级：模型 → 力度 → 模式 → 斜杠。
// draft 与附件投影仍只由本 hook 持有，调用方拿到的是同一份引用，不新增第二份事实。
export function useTuiDraftEditing(input: {
  effortCommand: ReturnType<typeof useEffortCommandController>;
  exitRequestedRef: MutableRefObject<boolean>;
  inputEditorRef: MutableRefObject<PromptInputEditor | null>;
  inputHistoryDraftAttachmentsRef: MutableRefObject<DraftAttachment[] | undefined>;
  inputHistoryDraftRef: MutableRefObject<string | undefined>;
  inputHistoryIndexRef: MutableRefObject<number>;
  modeCommand: ReturnType<typeof useModeCommandController>;
  modelCommand: ReturnType<typeof useModelCommandController>;
  setDraftState: Dispatch<SetStateAction<string>>;
  setSlashSelection: Dispatch<SetStateAction<SlashSelectionState | undefined>>;
  slashCommands: readonly SlashCommand[];
}): {
  draftAttachmentsRef: MutableRefObject<DraftAttachment[]>;
  draftRef: MutableRefObject<string>;
  setDraftAttachments: Dispatch<SetStateAction<DraftAttachment[]>>;
  setDraftValue: (value: string) => void;
} {
  const {
    effortCommand,
    exitRequestedRef,
    inputEditorRef,
    inputHistoryDraftAttachmentsRef,
    inputHistoryDraftRef,
    inputHistoryIndexRef,
    modeCommand,
    modelCommand,
    setDraftState,
    setSlashSelection,
    slashCommands,
  } = input;
  const draftRef = useRef("");
  const draftAttachmentsRef = useRef<DraftAttachment[]>([]);
  const [, setDraftAttachmentsState] = useState<DraftAttachment[]>([]);

  const setDraftAttachments = useCallback((action: SetStateAction<DraftAttachment[]>) => {
    const nextAttachments =
      typeof action === "function" ? action(draftAttachmentsRef.current) : action;
    draftAttachmentsRef.current = nextAttachments;
    setDraftAttachmentsState(nextAttachments);
  }, []);

  const setDraftValue = useCallback(
    (value: string) => {
      if (exitRequestedRef.current) return;
      draftRef.current = value;
      // 同批原生输入的提交会先于 React layout effect；立即清空同一 editor，
      // 防止延迟 content-change 复活旧 prompt，把下一条 /quit 拼到旧输入后排队。
      if (value.length === 0 && inputEditorRef.current)
        syncTextareaValue(inputEditorRef.current, value);
      setDraftState(value);
      setDraftAttachments((current) =>
        current.filter((attachment) => value.includes(attachment.placeholder)),
      );
      inputHistoryIndexRef.current = 0;
      inputHistoryDraftAttachmentsRef.current = undefined;
      inputHistoryDraftRef.current = undefined;
      const nextModelSelection = modelCommand.reconcileDraft(value);
      const nextEffortSelection = nextModelSelection
        ? undefined
        : effortCommand.reconcileDraft(value);
      const nextModeSelection =
        nextModelSelection || nextEffortSelection ? undefined : modeCommand.reconcileDraft(value);
      if (nextModelSelection) {
        effortCommand.setSelection(undefined);
        modeCommand.setSelection(undefined);
      } else if (nextEffortSelection) {
        modelCommand.setSelection(undefined);
        modeCommand.setSelection(undefined);
      } else if (nextModeSelection) {
        effortCommand.setSelection(undefined);
        modelCommand.setSelection(undefined);
      }
      setSlashSelection(
        nextModelSelection || nextEffortSelection || nextModeSelection
          ? undefined
          : reconcileSlashSelection(value, slashCommands),
      );
    },
    [
      effortCommand,
      exitRequestedRef,
      inputEditorRef,
      inputHistoryDraftAttachmentsRef,
      inputHistoryDraftRef,
      inputHistoryIndexRef,
      modeCommand,
      modelCommand,
      setDraftAttachments,
      setDraftState,
      setSlashSelection,
      slashCommands,
    ],
  );

  return { draftAttachmentsRef, draftRef, setDraftAttachments, setDraftValue };
}
