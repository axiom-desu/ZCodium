import type { BrowserCommand, BrowserCommandResult } from "@zcode/contracts";
import { executeManagedPageCommand } from "./page-command.js";
import type { ManagedCdpSession } from "./session.js";

/**
 * Managed CDP command dispatch. Session/tab ownership stays in
 * ManagedCdpBrowserControlPort; this module only maps one BrowserCommand onto
 * the session created by that runtime.
 */
export async function executeManagedSessionCommand(
  session: ManagedCdpSession,
  command: BrowserCommand,
): Promise<Omit<BrowserCommandResult, "elapsedMs">> {
  switch (command.method) {
    case "list":
      return { ok: true, tabs: await session.listTabs() };
    case "newTab": {
      const tab = await session.createTab();
      return { ok: true, tab: (await session.listTabs()).find((item) => item.tabId === tab.id) };
    }
    case "activateTab": {
      const tab = await session.activateTab(command.tabId);
      return { ok: true, tab: (await session.listTabs()).find((item) => item.tabId === tab.id) };
    }
    case "close":
      await session.closeTab(command.tabId);
      return { ok: true };
    case "browserViewportSet":
      await session.setViewport(command.tabId, { width: command.width, height: command.height });
      return { ok: true };
    case "browserViewportReset":
      await session.setViewport(command.tabId, null);
      return { ok: true };
    case "getDialog": {
      const tab = await session.ensureTab(command.tabId);
      const dialog = session.dialogFor(tab.id);
      const type = dialog?.type();
      return {
        ok: true,
        dialog:
          dialog && type && ["alert", "confirm", "prompt", "beforeunload"].includes(type)
            ? {
                type: type as "alert" | "confirm" | "prompt" | "beforeunload",
                message: dialog.message(),
                ...(dialog.defaultValue() ? { defaultPrompt: dialog.defaultValue() } : {}),
              }
            : null,
      };
    }
    case "handleDialog": {
      const tab = await session.ensureTab(command.tabId);
      const dialog = session.dialogFor(tab.id);
      if (!dialog) throw new Error("No JavaScript dialog is pending for this tab");
      if (command.accept) await dialog.accept(command.promptText);
      else await dialog.dismiss();
      session.clearDialog(tab.id);
      return { ok: true };
    }
    case "nameSession":
      return { ok: true };
    case "listUserTabs":
      return { ok: true, userTabs: [] };
    case "browserVisibilityGet":
    case "browserVisibilitySet":
    case "capabilities":
    case "claimTab":
    case "finalize":
    case "finalizeTabs":
    case "markDeliverable":
    case "markHandoff":
    case "turnEnded":
    case "closeSession":
    case "cancelRequest":
      return {
        ok: false,
        error: {
          code: "capability_unsupported",
          message: `Browser command '${command.method}' is unavailable in managed headless CDP`,
        },
      };
    default: {
      const tab = await session.ensureTab("tabId" in command ? command.tabId : undefined);
      return await executeManagedPageCommand(tab.page, command);
    }
  }
}
