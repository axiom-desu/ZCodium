import type { KeyEvent } from "@mbears/opentui-core";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { handleApprovalKey } from "./app-approval.js";
import { isTuiQuitInput } from "./app-input.js";
import { resetCtrlCExitGuard, type CtrlCExitGuard } from "./app-keyboard-helpers.js";
import { handlePendingQuitKey } from "./app-quit.js";
import type { ApprovalPrompt } from "./app-model.js";

// 审批队列是键盘输入的最高优先级。返回 true 表示本批按键已被审批流程消费，
// 调用方不能再把它当作普通草稿输入。顺序保持：正在编辑的问答全文 → 待提交 /quit → 面板按键。
// 没有审批时清除待提交 /quit 缓冲属于调用方的正常路径，不在这里处理。
export function handleApprovalRoutingKey(input: {
  consumeKey: (key: KeyEvent) => void;
  ctrlCExitGuard: CtrlCExitGuard;
  key: KeyEvent;
  approval: ApprovalPrompt;
  pendingQuitRef: MutableRefObject<string | undefined>;
  quitHint: string;
  tryQuit: (value?: string, origin?: "composer" | "approval") => boolean;
  setApprovalQueue: Dispatch<SetStateAction<ApprovalPrompt[]>>;
  setStatus: Dispatch<SetStateAction<string>>;
}): boolean {
  const { consumeKey, key, approval } = input;
  // 自定义问答保留真实文本（例如 /tmp/path）；只在显式提交完整 /quit 时退出。
  if (
    approval.questionState?.editingOther &&
    key.name === "return" &&
    !key.shift &&
    !key.option &&
    isTuiQuitInput(approval.questionState.otherBuffer) &&
    input.tryQuit(approval.questionState.otherBuffer, "approval")
  ) {
    consumeKey(key);
    return true;
  }
  if (
    !approval.questionState?.editingOther &&
    handlePendingQuitKey({
      key,
      buffer: input.pendingQuitRef,
      hint: input.quitHint,
      setStatus: input.setStatus,
      submit: (value) => {
        input.tryQuit(value, "approval");
      },
    })
  ) {
    consumeKey(key);
    return true;
  }
  resetCtrlCExitGuard(input.ctrlCExitGuard);
  consumeKey(key);
  handleApprovalKey(key, approval, input.setApprovalQueue, input.setStatus);
  return true;
}
