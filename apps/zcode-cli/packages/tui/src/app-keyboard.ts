import type { KeyEvent } from "@mbears/opentui-core";
import type { TuiWorkflowExpansionControls } from "./app-workflow-controller.js";
import { useKeyboard } from "@mbears/opentui-react";
import { useCallback, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { handleApprovalKey } from "./app-approval.js";
import { handlePendingQuitKey } from "./app-quit.js";
import { handleSelectionKey, isTuiQuitInput } from "./app-input.js";
import {
  CTRL_C_EXIT_PROMPT,
  PROMPT_DRAFT_CLEARED_STATUS,
  completeEffortCommand,
  completeModeCommand,
  completeModelCommand,
  completeSlashCommand,
  createCtrlCExitGuard,
  type CtrlCExitGuard,
  isModeSwitchKey,
  resetCtrlCExitGuard,
  resolveCtrlCExitIntent,
  shouldClearPromptDraftOnCtrlC,
  shouldHandleInputHistoryNavigation,
  workflowExpansionActionFor,
} from "./app-keyboard-helpers.js";
import { handleSuggestionNavigationKey } from "./app-keyboard-suggestions.js";
import { createSidebarShortcutState, type SidebarShortcutState } from "./app-sidebar-shortcut.js";
import { handleSidebarShortcutKey } from "./app-sidebar-keyboard.js";
import type {
  ApprovalPrompt,
  DraftAttachment,
  EffortCommandSelectionState,
  Message,
  ModeCommandSelectionState,
  ModelCommandSelectionState,
  SelectionState,
  SubmitValueOptions,
  SlashCommand,
  SlashSelectionState,
} from "./app-model.js";
import type { SidebarSectionId } from "./app-sidebar-layout.js";
import type { TuiEffortOption, TuiModeOption, TuiModelOption } from "./types.js";
import { latestRetryableCompactCommand } from "./app-compact-timeline.js";

export {
  CTRL_C_EXIT_CONFIRMATION_WINDOW_MS,
  completeEffortCommand,
  completeModeCommand,
  completeModelCommand,
  completeSlashCommand,
  createCtrlCExitGuard,
  isModeSwitchKey,
  resetCtrlCExitGuard,
  resolveCtrlCExitIntent,
  shouldHandleInputHistoryNavigation,
} from "./app-keyboard-helpers.js";

type UseTuiKeyboardControlsOptions = {
  readOnlyView?: { back(): void };
  abortControllerRef: MutableRefObject<AbortController | undefined>;
  getCurrentApproval: () => ApprovalPrompt | undefined;
  busy: boolean;
  copyCurrentSelection: () => boolean;
  draftValue: string;
  workflowExpansion?: TuiWorkflowExpansionControls;
  filteredEffortOptions: readonly TuiEffortOption[];
  filteredModeOptions: readonly TuiModeOption[];
  filteredModelOptions: readonly TuiModelOption[];
  filteredSlashCommands: readonly SlashCommand[];
  handleFileMentionKey: (key: KeyEvent) => boolean;
  inputHistoryActive: boolean;
  messages: readonly Message[];
  effortSelection: EffortCommandSelectionState | undefined;
  modelSelection: ModelCommandSelectionState | undefined;
  modeSelection: ModeCommandSelectionState | undefined;
  onExit: (code: number) => void;
  tryQuit: (value?: string, origin?: "composer" | "approval") => boolean;
  quitHint: string;
  pasteClipboardImage: () => Promise<void>;
  recallNextInput: () => Promise<void>;
  recallPreviousInput: () => Promise<void>;
  selection: SelectionState | undefined;
  setApprovalQueue: Dispatch<SetStateAction<ApprovalPrompt[]>>;
  setDraftAttachments: Dispatch<SetStateAction<DraftAttachment[]>>;
  setDraftValue: (value: string) => void;
  setEffortSelection: Dispatch<SetStateAction<EffortCommandSelectionState | undefined>>;
  setModelSelection: Dispatch<SetStateAction<ModelCommandSelectionState | undefined>>;
  setModeSelection: Dispatch<SetStateAction<ModeCommandSelectionState | undefined>>;
  setSelection: Dispatch<SetStateAction<SelectionState | undefined>>;
  setSlashSelection: Dispatch<SetStateAction<SlashSelectionState | undefined>>;
  setStatus: Dispatch<SetStateAction<string>>;
  slashSelection: SlashSelectionState | undefined;
  submitValue: (value: string, options?: SubmitValueOptions) => Promise<void>;
  switchMode: () => void;
  toggleSidebar: () => boolean;
  toggleSidebarSection: (section: SidebarSectionId) => boolean;
};

export function useTuiKeyboardControls({
  readOnlyView,
  abortControllerRef,
  getCurrentApproval,
  busy,
  copyCurrentSelection,
  draftValue,
  workflowExpansion,
  filteredEffortOptions,
  filteredModeOptions,
  filteredModelOptions,
  filteredSlashCommands,
  handleFileMentionKey,
  inputHistoryActive,
  messages,
  effortSelection,
  modelSelection,
  modeSelection,
  onExit,
  tryQuit,
  quitHint,
  pasteClipboardImage,
  recallNextInput,
  recallPreviousInput,
  selection,
  setApprovalQueue,
  setDraftAttachments,
  setDraftValue,
  setEffortSelection,
  setModelSelection,
  setModeSelection,
  setSelection,
  setSlashSelection,
  setStatus,
  slashSelection,
  submitValue,
  switchMode,
  toggleSidebar,
  toggleSidebarSection,
}: UseTuiKeyboardControlsOptions): void {
  const ctrlCExitGuardRef = useRef<CtrlCExitGuard>(createCtrlCExitGuard());
  const pendingQuitRef = useRef<string | undefined>(undefined);
  const sidebarShortcutRef = useRef<SidebarShortcutState>(createSidebarShortcutState());

  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        if (key.eventType === "release") return;

        // 仅普通 Enter 提交退出，Shift/Alt+Enter 仍是换行；隐藏子会话视图不能提交主草稿。
        if (
          !readOnlyView &&
          key.name === "return" &&
          !key.shift &&
          !key.option &&
          !key.ctrl &&
          !key.meta &&
          tryQuit()
        ) {
          consumeKey(key);
          return;
        }

        if (readOnlyView) {
          resetCtrlCExitGuard(ctrlCExitGuardRef.current);
          if (
            handleSidebarShortcutKey({
              consumeKey,
              key,
              nowMs: Date.now(),
              setStatus,
              shortcutState: sidebarShortcutRef.current,
              toggleSidebar,
              toggleSidebarSection,
            })
          )
            return;
          if (key.name === "escape") {
            consumeKey(key);
            readOnlyView.back();
          } else if ((key.name === "c" || key.name === "y") && key.ctrl) {
            consumeKey(key);
            copyCurrentSelection();
          } else if (
            !["up", "down", "left", "right", "pageup", "pagedown", "home", "end"].includes(key.name)
          ) {
            consumeKey(key);
          }
          return;
        }

        const approval = getCurrentApproval();
        if (!approval) pendingQuitRef.current = undefined;
        // 自定义问答保留真实文本（例如 /tmp/path）；只在显式提交完整 /quit 时退出。
        if (
          approval?.questionState?.editingOther &&
          key.name === "return" &&
          !key.shift &&
          !key.option &&
          isTuiQuitInput(approval.questionState.otherBuffer) &&
          tryQuit(approval.questionState.otherBuffer, "approval")
        ) {
          consumeKey(key);
          return;
        }
        if (
          approval &&
          !approval.questionState?.editingOther &&
          handlePendingQuitKey({
            key,
            buffer: pendingQuitRef,
            hint: quitHint,
            setStatus,
            submit: (value) => {
              tryQuit(value, "approval");
            },
          })
        ) {
          consumeKey(key);
          return;
        }
        if (approval) {
          resetCtrlCExitGuard(ctrlCExitGuardRef.current);
          consumeKey(key);
          handleApprovalKey(key, approval, setApprovalQueue, setStatus);
          return;
        }

        if (selection) {
          resetCtrlCExitGuard(ctrlCExitGuardRef.current);
          consumeKey(key);
          handleSelectionKey(key, selection, setSelection, setStatus, submitValue, () => {
            abortControllerRef.current?.abort();
          });
          return;
        }

        if (
          handleSidebarShortcutKey({
            consumeKey,
            key,
            nowMs: Date.now(),
            setStatus,
            shortcutState: sidebarShortcutRef.current,
            toggleSidebar,
            toggleSidebarSection,
          })
        ) {
          resetCtrlCExitGuard(ctrlCExitGuardRef.current);
          return;
        }

        if (key.name === "c" && key.ctrl) {
          consumeKey(key);
          if (copyCurrentSelection()) {
            resetCtrlCExitGuard(ctrlCExitGuardRef.current);
            return;
          }

          if (shouldClearPromptDraftOnCtrlC(draftValue)) {
            resetCtrlCExitGuard(ctrlCExitGuardRef.current);
            setDraftValue("");
            setDraftAttachments([]);
            setStatus(PROMPT_DRAFT_CLEARED_STATUS);
            return;
          }

          // A single Ctrl-C used to exit immediately, which made long sessions easy to lose.
          if (resolveCtrlCExitIntent(ctrlCExitGuardRef.current, Date.now()) === "confirm_exit") {
            abortControllerRef.current?.abort();
            onExit(0);
            return;
          }

          setStatus(CTRL_C_EXIT_PROMPT);
          return;
        }

        resetCtrlCExitGuard(ctrlCExitGuardRef.current);

        if (key.name === "y" && key.ctrl) {
          consumeKey(key);
          if (!copyCurrentSelection()) setStatus("No selected text to copy.");
          return;
        }

        if (key.name === "r" && key.ctrl) {
          const compactRetryCommand = latestRetryableCompactCommand(messages);
          if (compactRetryCommand) {
            consumeKey(key);
            if (busy) {
              setStatus("Agent is still responding.");
              return;
            }
            void submitValue(compactRetryCommand, { preserveSelection: true });
            return;
          }
        }

        // Mode switching belongs to the composer, including while @ suggestions
        // are open; file completion must only receive the remaining Tab keys.
        if (isModeSwitchKey(key)) {
          consumeKey(key);
          void switchMode();
          return;
        }

        if (handleFileMentionKey(key)) {
          consumeKey(key);
          return;
        }

        if (key.name === "tab") {
          consumeKey(key);
          if (completeModelCommand(filteredModelOptions, modelSelection, setDraftValue)) {
            setModelSelection(undefined);
            return;
          }
          if (completeEffortCommand(filteredEffortOptions, effortSelection, setDraftValue)) {
            setEffortSelection(undefined);
            return;
          }
          if (completeModeCommand(filteredModeOptions, modeSelection, setDraftValue)) {
            setModeSelection(undefined);
            return;
          }
          if (completeSlashCommand(filteredSlashCommands, slashSelection, setDraftValue)) {
            setSlashSelection(undefined);
          }
          return;
        }

        if (key.name === "escape") {
          consumeKey(key);
          if (modelSelection) {
            setModelSelection(undefined);
            setStatus("Model suggestions dismissed.");
            return;
          }
          if (effortSelection) {
            setEffortSelection(undefined);
            setStatus("Effort suggestions dismissed.");
            return;
          }
          if (modeSelection) {
            setModeSelection(undefined);
            setStatus("Mode suggestions dismissed.");
            return;
          }
          if (slashSelection) {
            setSlashSelection(undefined);
            setStatus("Slash suggestions dismissed.");
            return;
          }
          if (busy) {
            abortControllerRef.current?.abort();
            setStatus("Pausing current output...");
            return;
          }
          setStatus("No active output to pause. Press Ctrl-C twice to exit.");
          return;
        }

        if (
          handleSuggestionNavigationKey({
            consumeKey,
            effortSelection,
            filteredEffortOptions,
            filteredModeOptions,
            filteredModelOptions,
            filteredSlashCommands,
            key,
            modelSelection,
            modeSelection,
            setEffortSelection,
            setModeSelection,
            setModelSelection,
            setSlashSelection,
            slashSelection,
          })
        ) {
          return;
        }

        if (
          key.name === "up" &&
          shouldHandleInputHistoryNavigation({ draftValue, inputHistoryActive })
        ) {
          consumeKey(key);
          void recallPreviousInput();
          return;
        }

        if (
          key.name === "down" &&
          shouldHandleInputHistoryNavigation({ draftValue, inputHistoryActive })
        ) {
          consumeKey(key);
          void recallNextInput();
          return;
        }

        // `+` / `-` 展开/收起全部 workflow 卡（spec 无卡片选择机制，只能作用于全体）。
        // 键位与两层闸门（草稿为空 + 至少一张卡）全部收在纯函数里，直接可测。
        const workflowExpansionKey = workflowExpansionActionFor({
          key,
          draftValue,
          hasCards: workflowExpansion?.hasCards ?? false,
        });
        if (workflowExpansionKey && workflowExpansion) {
          consumeKey(key);
          if (workflowExpansionKey === "expand") workflowExpansion.expandAll();
          else workflowExpansion.collapseAll();
          return;
        }

        if (key.name === "u" && key.ctrl) {
          consumeKey(key);
          setDraftValue("");
          setDraftAttachments([]);
          setStatus(PROMPT_DRAFT_CLEARED_STATUS);
          return;
        }

        if ((key.name === "v" && (key.ctrl || key.meta)) || key.raw === "\x16") {
          consumeKey(key);
          void pasteClipboardImage();
        }
      },
      [
        readOnlyView,
        abortControllerRef,
        getCurrentApproval,
        workflowExpansion,
        busy,
        copyCurrentSelection,
        draftValue,
        effortSelection,
        filteredEffortOptions,
        filteredModeOptions,
        filteredModelOptions,
        filteredSlashCommands,
        handleFileMentionKey,
        inputHistoryActive,
        messages,
        modelSelection,
        modeSelection,
        onExit,
        tryQuit,
        quitHint,
        pasteClipboardImage,
        recallNextInput,
        recallPreviousInput,
        selection,
        setApprovalQueue,
        setDraftAttachments,
        setDraftValue,
        setEffortSelection,
        setModelSelection,
        setModeSelection,
        setSelection,
        setSlashSelection,
        setStatus,
        slashSelection,
        submitValue,
        switchMode,
        toggleSidebar,
        toggleSidebarSection,
      ],
    ),
  );
}

function consumeKey(key: KeyEvent): void {
  key.preventDefault();
  key.stopPropagation();
}
