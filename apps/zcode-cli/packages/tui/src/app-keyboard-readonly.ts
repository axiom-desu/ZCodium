import type { KeyEvent } from "@mbears/opentui-core";
import type { Dispatch, SetStateAction } from "react";
import { resetCtrlCExitGuard, type CtrlCExitGuard } from "./app-keyboard-helpers.js";
import { handleSidebarShortcutKey } from "./app-sidebar-keyboard.js";
import type { SidebarShortcutState } from "./app-sidebar-shortcut.js";
import type { SidebarSectionId } from "./app-sidebar-layout.js";

// 隐藏子会话视图独占键盘：先给侧栏快捷键，再处理返回/复制，其余按键一律吞掉，
// 避免主草稿或审批队列在只读视图里收到输入。调用方在返回后直接结束本批按键。
export function handleReadOnlyViewKey(input: {
  consumeKey: (key: KeyEvent) => void;
  ctrlCExitGuard: CtrlCExitGuard;
  key: KeyEvent;
  readOnlyView: { back(): void };
  copyCurrentSelection: () => boolean;
  setStatus: Dispatch<SetStateAction<string>>;
  shortcutState: SidebarShortcutState;
  toggleSidebar: () => boolean;
  toggleSidebarSection: (section: SidebarSectionId) => boolean;
}): void {
  const { consumeKey, key, setStatus } = input;
  resetCtrlCExitGuard(input.ctrlCExitGuard);
  if (
    handleSidebarShortcutKey({
      consumeKey,
      key,
      nowMs: Date.now(),
      setStatus,
      shortcutState: input.shortcutState,
      toggleSidebar: input.toggleSidebar,
      toggleSidebarSection: input.toggleSidebarSection,
    })
  )
    return;
  if (key.name === "escape") {
    consumeKey(key);
    input.readOnlyView.back();
  } else if ((key.name === "c" || key.name === "y") && key.ctrl) {
    consumeKey(key);
    input.copyCurrentSelection();
  } else if (
    !["up", "down", "left", "right", "pageup", "pagedown", "home", "end"].includes(key.name)
  ) {
    consumeKey(key);
  }
}
