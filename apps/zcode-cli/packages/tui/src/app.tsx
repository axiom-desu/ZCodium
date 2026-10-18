import type { ModelUsageSummary, TodoItem, TurnId } from "@zcode/contracts";
import { getZCodeCopy } from "@zcode/i18n";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { AppView } from "./app-view.js";
import { syncTextareaValue, type PromptInputEditor } from "./app-input-pane.js";
import { selectionCopyStatus, type SelectionCopyResult } from "./app-copy.js";
import { useClipboardImagePaste } from "./app-clipboard-image.js";
import { useFileMentionController } from "./app-file-mentions.js";
import { useTuiKeyboardControls } from "./app-keyboard.js";
import { useTuiModeSwitcher } from "./app-mode.js";
import { createTuiPermissionRequester } from "./app-permission.js";
import { appendAgentResult } from "./app-submit.js";
import { useSubmitValue } from "./app-submit-controller.js";
import {
  filterSlashCommands,
  reconcileSlashSelection,
  tuiSlashCommands,
  trySubmitTuiQuit,
} from "./app-input.js";
import { useEffortCommandController } from "./app-effort-command.js";
import { useInputHistory } from "./app-input-history.js";
import { useModeCommandController } from "./app-mode-command.js";
import { useModelCommandController } from "./app-model-command.js";
import { useSidebarController } from "./app-sidebar-layout.js";
import { createSelectionState } from "./app-selection-state.js";
import { resolveComposerSubmittedText } from "./app-submit-resolver.js";
import type {
  ApprovalPrompt,
  CacheStats,
  ContextUsage,
  DraftAttachment,
  Message,
  ModifiedFileStat,
  NetworkRequest,
  QueuedInput,
  SelectionState,
  SlashSelectionState,
} from "./app-model.js";
import { useTuiThemeSync } from "./app-theme-sync.js";
import { useSessionEventApplier } from "./app-session-event-handler.js";
import { useTuiWorkflowRuns } from "./app-workflow-controller.js";
import { useTuiApplyResult } from "./app-result.js";
import { useSubagents } from "./app-subagents.js";
import type { TuiOptions } from "./types.js";

type TuiAppProps = {
  copySelection: () => Promise<SelectionCopyResult>;
  hasCopyableSelection: () => boolean;
  options: TuiOptions;
  onExit: (code: number) => void;
};

export function TuiApp({
  copySelection,
  hasCopyableSelection,
  onExit,
  options,
}: TuiAppProps): React.ReactElement {
  // Startup sentinels are diagnostics, not user-visible transcript messages.
  const initialResult = options.initialResult;
  useTuiThemeSync(options);
  const [messages, setMessages] = useState<Message[]>(() =>
    initialResult
      ? appendAgentResult([], initialResult, { workspaceDirectory: options.workspaceDirectory })
      : [],
  );
  const [draft, setDraftState] = useState("");
  const [, setDraftAttachmentsState] = useState<DraftAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(initialResult?.mode ?? options.initialMode ?? "build");
  const [model, setModel] = useState(initialResult?.model ?? options.initialModel ?? "unknown");
  const [thoughtLevel, setThoughtLevel] = useState(
    initialResult?.thoughtLevel ?? options.initialThoughtLevel ?? "",
  );
  const [locale, setLocale] = useState(options.locale ?? "en-US");
  const [lastEvent, setLastEvent] = useState("idle");
  const [lastError, setLastError] = useState<string | undefined>();
  const copy = useMemo(() => getZCodeCopy(locale), [locale]);
  const [modelSetupRequired, setModelSetupRequired] = useState(
    initialResult?.modelSetupRequired ?? options.modelSetupRequired ?? false,
  );
  const [status, setStatus] = useState(
    initialResult?.selection?.prompt ??
      (modelSetupRequired ? copy.tui.modelSetupRequired.status : copy.tui.status.ready),
  );
  const [statusDetails, setStatusDetails] = useState<string[]>([]);
  const [traceId, setTraceId] = useState<string | undefined>();
  const [activeTurnId, setActiveTurnId] = useState<TurnId | undefined>();
  const [contextUsage, setContextUsage] = useState<ContextUsage>({});
  const [cacheStats, setCacheStats] = useState<CacheStats | undefined>();
  const [usage, setUsage] = useState<ModelUsageSummary | undefined>();
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [networkRequests, setNetworkRequests] = useState<NetworkRequest[]>([]);
  const [modifiedFiles, setModifiedFiles] = useState<ModifiedFileStat[]>([]);
  const [liveModelText, setLiveModelText] = useState("");
  const [queuedInputs, setQueuedInputs] = useState<QueuedInput[]>([]);
  const [selection, setSelection] = useState<SelectionState | undefined>(() =>
    createSelectionState(initialResult?.selection),
  );
  const [slashSelection, setSlashSelection] = useState<SlashSelectionState | undefined>();
  const [approvalQueue, setApprovalQueueState] = useState<ApprovalPrompt[]>([]);
  const approvalQueueRef = useRef<ApprovalPrompt[]>([]);
  // 快速同批按键发生在下一次 render 之前；同步 owner 保存最新局部审批，state 只投影给界面。
  const setApprovalQueue = useCallback((action: React.SetStateAction<ApprovalPrompt[]>) => {
    const next = typeof action === "function" ? action(approvalQueueRef.current) : action;
    approvalQueueRef.current = next;
    setApprovalQueueState(next);
  }, []);
  const getCurrentApproval = useCallback(() => approvalQueueRef.current[0], []);
  const [inputCursorToEndVersion, setInputCursorToEndVersion] = useState(0);
  // dwf 运行态镜像：共享 reducer 逐事件维护 + 冷启动一次性补种，无第二时钟。
  const workflowRuns = useTuiWorkflowRuns({ copy: copy.tui, options, setMessages });
  const sidebar = useSidebarController();
  const subagents = useSubagents(options);

  const abortControllerRef = useRef<AbortController | undefined>(undefined);
  const exitRequestedRef = useRef(false);
  const draftRef = useRef("");
  const draftAttachmentsRef = useRef<DraftAttachment[]>([]);
  const inputEditorRef = useRef<PromptInputEditor | null>(null);
  const inputHistoryIndexRef = useRef(0);
  const inputHistoryDraftAttachmentsRef = useRef<DraftAttachment[] | undefined>(undefined);
  const inputHistoryDraftRef = useRef<string | undefined>(undefined);
  const nextAttachmentIdRef = useRef(1);
  const assistantMessageIdsByToolCallIdRef = useRef(new Map<string, string>());
  const modifiedFileToolCallIdsRef = useRef(new Set<string>());
  const toolNamesByIdRef = useRef(new Map<string, string>());

  const slashCommands = useMemo(
    () => tuiSlashCommands(options.slashCommands, copy.tui.terminal.quit),
    [options.slashCommands, copy.tui.terminal.quit],
  );
  const [effortOptions, setEffortOptions] = useState<NonNullable<TuiOptions["effortOptions"]>>(
    () => initialResult?.effortOptions ?? options.effortOptions ?? [],
  );
  const filteredSlashCommands = useMemo(
    () => filterSlashCommands(draft, slashCommands),
    [draft, slashCommands],
  );
  const effortCommand = useEffortCommandController(draft, effortOptions);
  const modelCommand = useModelCommandController(draft, options);
  const modeCommand = useModeCommandController(draft);

  const setDraftAttachments = useCallback((action: React.SetStateAction<DraftAttachment[]>) => {
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
    [effortCommand, modeCommand, modelCommand, setDraftAttachments, slashCommands],
  );

  const applyResult = useTuiApplyResult({
    fallback: { locale, modelSetupRequired, mode, model },
    modifiedFileToolCallIds: modifiedFileToolCallIdsRef.current,
    setActiveTurnId,
    setCacheStats,
    setContextUsage,
    setEffortOptions,
    setLastEvent,
    setLiveModelText,
    setLocale,
    setModelSetupRequired,
    setMessages,
    setMode,
    setModel,
    setModelOptions: modelCommand.setModelOptions,
    setModifiedFiles,
    setNetworkRequests,
    setQueuedInputs,
    setSelection,
    setStatus,
    setThoughtLevel,
    setTodos,
    setTraceId,
    setUsage,
    workspaceDirectory: options.workspaceDirectory,
  });

  const applySessionEvent = useSessionEventApplier({
    subscribeSessionEvents: options.subscribeSessionEvents,
    observeSessionEvent: subagents.onEvent,
    copy: copy.tui,
    getMainSessionId: options.getMainSessionId,
    setActiveTurnId,
    setCacheStats,
    setContextUsage,
    setLastError,
    setLastEvent,
    setLiveModelText,
    setMessages,
    setModel,
    setThoughtLevel,
    setModifiedFiles,
    setNetworkRequests,
    setQueuedInputs,
    setStatus,
    setTodos,
    setUsage,
    setWorkflowMirror: workflowRuns.setMirror,
    assistantMessageIdsByToolCallId: assistantMessageIdsByToolCallIdRef.current,
    modifiedFileToolCallIds: modifiedFileToolCallIdsRef.current,
    toolNamesById: toolNamesByIdRef.current,
    workspaceDirectory: options.workspaceDirectory,
  });

  const requestPermission = useMemo(
    () => createTuiPermissionRequester({ setApprovalQueue, setStatus }),
    [setApprovalQueue],
  );

  const resolveSubmittedText = useCallback(
    (submittedValue: string) => {
      const modelOption = modelCommand.selectedOption(submittedValue);
      const effortOption = modelOption ? undefined : effortCommand.selectedOption(submittedValue);
      return resolveComposerSubmittedText({
        effortOption,
        modeOption:
          modelOption || effortOption ? undefined : modeCommand.selectedOption(submittedValue),
        modelOption,
        slashCommands: filteredSlashCommands,
        slashSelection,
        submittedValue,
      });
    },
    [effortCommand, filteredSlashCommands, modeCommand, modelCommand, slashSelection],
  );

  const requestExit = useCallback(() => {
    if (exitRequestedRef.current) return;
    exitRequestedRef.current = true;
    abortControllerRef.current?.abort();
    onExit(0);
  }, [onExit]);
  const submitValue = useSubmitValue({
    activeTurnId,
    applyResult,
    applySessionEvent,
    busy,
    draftAttachmentsRef,
    emptyPromptStatus: copy.tui.input.typePrompt,
    messageInsertIndex: messages.length,
    options,
    requestPermission,
    resolveSubmittedText,
    resolveSubmittedModel: (value) => modelCommand.selectedOption(value)?.ref,
    setBusy,
    setDraftAttachments,
    setDraftValue,
    setLastError,
    setLiveModelText,
    setMessages,
    setQueuedInputs,
    setSelection,
    setSlashSelection,
    setStatus,
    setStatusDetails,
    turnRef: abortControllerRef,
    requestExit,
    quitSummary: copy.tui.terminal.quit,
  });
  const tryQuit = useCallback(
    (value = draftRef.current, origin: "composer" | "approval" = "composer") =>
      trySubmitTuiQuit({
        draft: value,
        hasAttachments: origin === "composer" && draftAttachmentsRef.current.length > 0,
        submit: requestExit,
      }),
    [requestExit],
  );

  const pasteClipboardImage = useClipboardImagePaste({
    abortControllerRef,
    busy,
    getDraftValue: () => draftRef.current,
    inputEditorRef,
    nextAttachmentIdRef,
    options,
    setDraftAttachments,
    setDraftValue,
    setStatus,
    setStatusDetails,
  });

  const { recallNextInput, recallPreviousInput } = useInputHistory({
    copy: copy.tui,
    draftAttachmentsRef,
    draftRef,
    inputHistoryDraftAttachmentsRef,
    inputHistoryDraftRef,
    inputHistoryIndexRef,
    nextAttachmentIdRef,
    options,
    setDraftAttachments,
    setDraftState,
    setDraftValue,
    setInputCursorToEndVersion,
    setSlashSelection,
    setStatus,
    setStatusDetails,
  });

  const fileMentions = useFileMentionController({
    busy,
    draft,
    editorRef: inputEditorRef,
    listWorkspacePathSuggestions: options.listWorkspacePathSuggestions,
    nextAttachmentIdRef,
    setDraftAttachments,
    setDraftValue,
    setSlashSelection,
    setStatus,
  });

  const copyCurrentSelection = useCallback((): boolean => {
    if (!hasCopyableSelection()) return false;
    void copySelection().then((result) => {
      const copyStatus = selectionCopyStatus(result, copy.tui.copy);
      if (copyStatus.status) setStatus(copyStatus.status);
      if (copyStatus.details) setStatusDetails(copyStatus.details);
    });
    return true;
  }, [copy, copySelection, hasCopyableSelection]);
  const switchMode = useTuiModeSwitcher({
    mode,
    setMode,
    setModeHandler: options.setMode,
    setStatus,
  });

  useTuiKeyboardControls({
    readOnlyView: subagents.selected ? { back: subagents.back } : undefined,
    abortControllerRef,
    getCurrentApproval,
    busy,
    copyCurrentSelection,
    effortSelection: effortCommand.selection,
    filteredEffortOptions: effortCommand.filteredOptions,
    filteredSlashCommands,
    filteredModeOptions: modeCommand.filteredOptions,
    filteredModelOptions: modelCommand.filteredOptions,
    handleFileMentionKey: fileMentions.handleKey,
    onExit: requestExit,
    tryQuit,
    quitHint: copy.tui.terminal.quit,
    pasteClipboardImage,
    recallNextInput,
    recallPreviousInput,
    draftValue: draft,
    inputHistoryActive: inputHistoryDraftRef.current !== undefined,
    messages,
    modelSelection: modelCommand.selection,
    modeSelection: modeCommand.selection,
    selection,
    setApprovalQueue,
    setDraftAttachments,
    setDraftValue,
    setEffortSelection: effortCommand.setSelection,
    setModelSelection: modelCommand.setSelection,
    setModeSelection: modeCommand.setSelection,
    setSelection,
    setSlashSelection,
    setStatus,
    slashSelection,
    submitValue,
    switchMode,
    workflowExpansion: workflowRuns.expansion,
    toggleSidebar: sidebar.toggleSidebar,
    toggleSidebarSection: sidebar.toggleSidebarSection,
  });

  return React.createElement(AppView, {
    subagents,
    toggleSidebar: sidebar.toggleSidebar,
    activeTurnId,
    approvalQueue,
    busy,
    cacheStats,
    contextUsage,
    copy: copy.tui,
    copyCurrentSelection,
    draft,
    editorRef: inputEditorRef,
    inputCursorToEndVersion,
    lastError,
    lastEvent,
    modelSetupRequired,
    liveModelText,
    mode,
    model,
    messages,
    modifiedFiles,
    networkRequests,
    options,
    queuedInputs,
    selection,
    fileMention: fileMentions.state,
    setDraftValue,
    sidebarLayout: sidebar.layout,
    sidebarSections: sidebar.sections,
    effortOptions: effortCommand.filteredOptions,
    effortSelection: effortCommand.selection,
    modelOptions: modelCommand.filteredOptions,
    modelSelection: modelCommand.selection,
    modeOptions: modeCommand.filteredOptions,
    modeSelection: modeCommand.selection,
    slashCommands: filteredSlashCommands,
    slashSelection,
    status,
    statusDetails,
    submitValue,
    thoughtLevel,
    todos,
    toggleSidebarSection: sidebar.toggleSidebarSection,
    traceId,
    terminalWidth: sidebar.terminalWidth,
    usage,
    workflowCardsByToolCallId: workflowRuns.cardsByToolCallId,
    expandedWorkflowRunIds: workflowRuns.expandedRunIds,
  });
}
