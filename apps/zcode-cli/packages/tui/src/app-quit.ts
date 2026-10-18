import type { KeyEvent } from "@mbears/opentui-core";
import { isTuiQuitInput, printableKey } from "./app-input.js";

// 审批占用键盘时仍能输入本地退出命令；这只是瞬时手势草稿，不改用户 composer 或审批决定。
export function handlePendingQuitKey(input: {
  key: KeyEvent;
  buffer: { current: string | undefined };
  hint: string;
  setStatus(value: string): void;
  submit(value: string): void;
}): boolean {
  const { key, buffer } = input;
  if (key.ctrl || key.meta || key.option) {
    buffer.current = undefined;
    return false;
  }
  const char = printableKey(key);
  if (buffer.current === undefined) {
    if (char !== "/") return false;
    buffer.current = "/";
  } else if (key.name === "escape") {
    buffer.current = undefined;
    input.setStatus(input.hint);
    return true;
  } else if (key.name === "return" && !key.shift) {
    const value = buffer.current;
    buffer.current = undefined;
    if (isTuiQuitInput(value)) input.submit(value);
    else input.setStatus(`${input.hint}: /quit`);
    return true;
  } else if (key.name === "backspace") {
    buffer.current = buffer.current.slice(0, -1) || undefined;
  } else if (char !== undefined && buffer.current.length < 16) {
    buffer.current += char;
  }
  input.setStatus(`${input.hint}: ${buffer.current ?? ""} · Enter / Esc`);
  return true;
}
