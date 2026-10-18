import type { AskUserQuestionAnnotation, AskUserQuestionInput } from "@zcode/contracts";
import type { KeyEvent } from "@mbears/opentui-core";
import type React from "react";
import type { ApprovalPrompt, QuestionPromptState } from "./app-model.js";
import { clampIndex, printableKey } from "./app-input.js";

export function createQuestionPromptState(input: AskUserQuestionInput): QuestionPromptState {
  return {
    annotations: {},
    answers: {},
    currentQuestionIndex: 0,
    editingOther: false,
    input,
    multiSelections: {},
    otherBuffer: "",
    otherText: {},
    reviewing: false,
    selectedOptionIndex: 0,
  };
}

export function handleQuestionKey(
  key: KeyEvent,
  approval: ApprovalPrompt,
  setApprovalQueue: React.Dispatch<React.SetStateAction<ApprovalPrompt[]>>,
  setStatus: (status: string) => void,
): void {
  const state = approval.questionState;
  if (!state) return;

  const update = (recipe: (draft: QuestionPromptState) => void) => {
    setApprovalQueue((current) =>
      current.map((item) => {
        // 每键都会 clone approval；按对象引用匹配会丢掉同批后续按键。resolve 是该审批稳定的 UI 句柄。
        if (item.resolve !== approval.resolve || !item.questionState) return item;
        const nextState = cloneQuestionState(item.questionState);
        recipe(nextState);
        return {
          ...item,
          questionState: nextState,
        };
      }),
    );
  };

  if (state.reviewing) {
    handleQuestionReviewKey(key, approval, state, update, setApprovalQueue, setStatus);
    return;
  }

  const question = state.input.questions[state.currentQuestionIndex];
  if (!question) return;
  const otherIndex = question.options.length;

  if (state.editingOther) {
    handleOtherAnswerKey(key, state, update, setStatus);
    return;
  }

  if (key.name === "escape") {
    denyQuestion(approval, setApprovalQueue, setStatus);
    return;
  }

  if (key.name === "up" || printableKey(key)?.toLowerCase() === "k") {
    update((draft) => {
      draft.selectedOptionIndex = clampIndex(draft.selectedOptionIndex - 1, otherIndex + 1);
    });
    return;
  }
  if (key.name === "down" || printableKey(key)?.toLowerCase() === "j") {
    update((draft) => {
      draft.selectedOptionIndex = clampIndex(draft.selectedOptionIndex + 1, otherIndex + 1);
    });
    return;
  }
  if (key.name === "o") {
    update((draft) => {
      const target = draft.input.questions[draft.currentQuestionIndex];
      if (!target) return;
      draft.editingOther = true;
      draft.otherBuffer = draft.otherText[target.question] ?? "";
      draft.selectedOptionIndex = target.options.length;
    });
    setStatus("Type a custom answer. Press Enter to accept.");
    return;
  }
  if (key.name === "s") {
    skipQuestionAnswer(state, update, setStatus);
    return;
  }
  if (question.multiSelect && key.name === "space") {
    update((draft) => {
      toggleQuestionSelection(draft);
    });
    return;
  }
  if (/^[1-9]$/.test(key.name)) {
    const selected = Number(key.name) - 1;
    update((draft) => {
      draft.selectedOptionIndex = clampIndex(selected, otherIndex + 1);
      if (question.multiSelect) toggleQuestionSelection(draft);
    });
    return;
  }
  if (key.name === "return") {
    submitQuestionAnswer(state, update, setStatus);
  }
}

function handleQuestionReviewKey(
  key: KeyEvent,
  approval: ApprovalPrompt,
  state: QuestionPromptState,
  update: (recipe: (draft: QuestionPromptState) => void) => void,
  setApprovalQueue: React.Dispatch<React.SetStateAction<ApprovalPrompt[]>>,
  setStatus: (status: string) => void,
): void {
  if (key.name === "return") {
    approval.cleanup();
    approval.resolve({
      decision: "modify",
      modifiedInput: {
        annotations: state.annotations,
        answers: state.answers,
        questions: state.input.questions,
      },
      reason: "Answered in TUI",
      resolvedAt: new Date(),
    });
    setApprovalQueue((current) => current.filter((item) => item.resolve !== approval.resolve));
    setStatus(`Answered ${Object.keys(state.answers).length} clarification questions.`);
    return;
  }
  if (key.name === "escape") {
    denyQuestion(approval, setApprovalQueue, setStatus);
    return;
  }
  if (key.name === "tab" || key.name === "pageup") {
    update((draft) => {
      draft.reviewing = false;
      draft.currentQuestionIndex = key.name === "pageup" ? draft.input.questions.length - 1 : 0;
      draft.selectedOptionIndex = 0;
    });
  }
}

function handleOtherAnswerKey(
  key: KeyEvent,
  state: QuestionPromptState,
  update: (recipe: (draft: QuestionPromptState) => void) => void,
  setStatus: (status: string) => void,
): void {
  if (key.name === "return") {
    const other = state.otherBuffer.trim();
    if (!other) {
      setStatus("Other answer cannot be empty.");
      return;
    }
    update((draft) => {
      const target = draft.input.questions[draft.currentQuestionIndex];
      if (!target) return;
      draft.otherText[target.question] = other;
      draft.selectedOptionIndex = target.options.length;
      draft.editingOther = false;
      draft.otherBuffer = "";
      if (target.multiSelect) {
        draft.multiSelections[target.question] = [
          ...new Set([...(draft.multiSelections[target.question] ?? []), "Other"]),
        ];
      }
    });
    setStatus("Other answer added.");
    return;
  }
  if (key.name === "escape") {
    update((draft) => {
      draft.editingOther = false;
      draft.otherBuffer = "";
    });
    setStatus("Other input cancelled.");
    return;
  }
  if (key.name === "backspace") {
    update((draft) => {
      draft.otherBuffer = draft.otherBuffer.slice(0, -1);
    });
    return;
  }
  if (key.name === "u" && key.ctrl) {
    update((draft) => {
      draft.otherBuffer = "";
    });
    setStatus("Other answer cleared.");
    return;
  }
  const character = printableKey(key);
  if (character) {
    update((draft) => {
      draft.otherBuffer = `${draft.otherBuffer}${character}`;
    });
  }
}

function submitQuestionAnswer(
  state: QuestionPromptState,
  update: (recipe: (draft: QuestionPromptState) => void) => void,
  setStatus: (status: string) => void,
): void {
  const question = state.input.questions[state.currentQuestionIndex];
  if (!question) return;
  const otherIndex = question.options.length;

  if (state.selectedOptionIndex === otherIndex && !state.otherText[question.question]) {
    update((draft) => {
      draft.editingOther = true;
      draft.otherBuffer = "";
    });
    setStatus("Type a custom answer. Press Enter to accept.");
    return;
  }

  const answer = answerCurrentQuestion(state);
  if (!answer) {
    setStatus("Select at least one option, or choose Other.");
    return;
  }

  update((draft) => {
    const target = draft.input.questions[draft.currentQuestionIndex];
    if (!target) return;
    const nextAnswer = answerCurrentQuestion(draft);
    if (!nextAnswer) return;
    draft.answers[target.question] = nextAnswer.answer;
    if (nextAnswer.annotation) {
      draft.annotations[target.question] = nextAnswer.annotation;
    } else {
      delete draft.annotations[target.question];
    }
    if (draft.currentQuestionIndex >= draft.input.questions.length - 1) {
      draft.reviewing = true;
    } else {
      draft.currentQuestionIndex += 1;
      draft.selectedOptionIndex = 0;
    }
  });
  setStatus("Review answers, then press Enter to submit.");
}

function skipQuestionAnswer(
  state: QuestionPromptState,
  update: (recipe: (draft: QuestionPromptState) => void) => void,
  setStatus: (status: string) => void,
): void {
  const question = state.input.questions[state.currentQuestionIndex];
  if (!question) return;

  update((draft) => {
    const target = draft.input.questions[draft.currentQuestionIndex];
    if (!target) return;
    // 焦点只服务键盘导航；显式跳过必须清除该题已有草稿并推进，
    // 不能把焦点选项或本地化的“跳过”文案写进共享 answers 契约。
    delete draft.answers[target.question];
    delete draft.annotations[target.question];
    delete draft.multiSelections[target.question];
    delete draft.otherText[target.question];
    if (draft.currentQuestionIndex >= draft.input.questions.length - 1) {
      draft.reviewing = true;
    } else {
      draft.currentQuestionIndex += 1;
      draft.selectedOptionIndex = 0;
    }
  });
  setStatus(
    state.currentQuestionIndex >= state.input.questions.length - 1
      ? "Review answers, then press Enter to submit."
      : "Question skipped.",
  );
}

function denyQuestion(
  approval: ApprovalPrompt,
  setApprovalQueue: React.Dispatch<React.SetStateAction<ApprovalPrompt[]>>,
  setStatus: (status: string) => void,
): void {
  approval.cleanup();
  approval.resolve({
    decision: "deny",
    reason: "Denied in TUI",
    resolvedAt: new Date(),
  });
  setApprovalQueue((current) => current.filter((item) => item.resolve !== approval.resolve));
  setStatus("Clarification declined.");
}

function cloneQuestionState(state: QuestionPromptState): QuestionPromptState {
  return {
    ...state,
    annotations: { ...state.annotations },
    answers: { ...state.answers },
    multiSelections: Object.fromEntries(
      Object.entries(state.multiSelections).map(([key, value]) => [key, [...value]]),
    ),
    otherText: { ...state.otherText },
  };
}

function toggleQuestionSelection(state: QuestionPromptState): void {
  const question = state.input.questions[state.currentQuestionIndex];
  if (!question) return;
  const label =
    state.selectedOptionIndex === question.options.length
      ? "Other"
      : question.options[state.selectedOptionIndex]?.label;
  if (!label) return;
  const current = new Set(state.multiSelections[question.question] ?? []);
  if (current.has(label)) current.delete(label);
  else current.add(label);
  state.multiSelections[question.question] = [...current];
}

function answerCurrentQuestion(
  state: QuestionPromptState,
): { annotation?: AskUserQuestionAnnotation; answer: string } | undefined {
  const question = state.input.questions[state.currentQuestionIndex];
  if (!question) return undefined;

  const selectedLabels = question.multiSelect
    ? (state.multiSelections[question.question] ?? [])
    : [
        state.selectedOptionIndex === question.options.length
          ? "Other"
          : question.options[state.selectedOptionIndex]?.label,
      ].filter((label): label is string => Boolean(label));

  const answers = selectedLabels
    .map((label) => (label === "Other" ? state.otherText[question.question] : label))
    .filter((label): label is string => Boolean(label && label.trim().length > 0));
  if (answers.length === 0) return undefined;

  const previews = selectedLabels
    .map((label) => question.options.find((option) => option.label === label)?.preview)
    .filter((preview): preview is string => Boolean(preview));

  return {
    annotation:
      previews.length > 0
        ? {
            preview: previews.join("\n\n"),
          }
        : undefined,
    answer: answers.join(", "),
  };
}
