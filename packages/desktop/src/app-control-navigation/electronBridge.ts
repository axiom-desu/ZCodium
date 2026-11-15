import type { BrowserWindow, IpcMain, UtilityProcess, WebContents } from "electron";
import {
  appControlNavigationRendererIpcSchema,
  hostAppNavigationCancelResponseSchema,
  hostAppNavigationOpenResponseSchema,
} from "@zcode/shared";
import { createAppControlNavigationWindow } from "./windowBridge.js";
import {
  APP_NAVIGATION_IPC,
  type AppControlNavigationWindow,
  type AppNavigationSource,
} from "./contract.js";

const surfaces = new WeakMap<BrowserWindow, AppControlNavigationWindow>();
const registered = new WeakSet<object>();

function windowSurface(win: BrowserWindow): AppControlNavigationWindow {
  const current = surfaces.get(win);
  if (current) return current;
  const surface = createAppControlNavigationWindow({
    uiTarget: `window:${win.id}`,
    send: (message) => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) throw new Error("window-closed");
      win.webContents.send(APP_NAVIGATION_IPC, message);
    },
  });
  surfaces.set(win, surface);
  // 同一窗口只创建一次 surface 与监听器。reload 只失效 renderer generation，不替换 owner。
  const invalidate = () => surface.invalidate();
  win.webContents.on("render-process-gone", invalidate);
  win.webContents.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) invalidate();
  });
  win.once("closed", () => {
    surface.dispose();
    surfaces.delete(win);
  });
  return surface;
}

/** IPC sender 决定窗口，payload 不接受自报 windowId。手机没有这条 Electron 通道。 */
export function registerAppControlNavigationIpc(
  ipcMain: Pick<IpcMain, "on">,
  fromWebContents: (contents: WebContents) => BrowserWindow | null,
): void {
  if (registered.has(ipcMain)) return;
  registered.add(ipcMain);
  ipcMain.on(APP_NAVIGATION_IPC, (event, payload: unknown) => {
    const win = fromWebContents(event.sender);
    // senderFrame 必须就是主框架：iframe/guest 不能代替窗口登记或提交导航回执。
    if (!win || event.senderFrame !== event.sender.mainFrame) return;
    const parsed = appControlNavigationRendererIpcSchema.safeParse(payload);
    if (!parsed.success) return;
    const message = parsed.data;
    const surface = windowSurface(win);
    if (message.type === "register") surface.register(message.generation);
    else if (message.type === "unregister") surface.unregister(message.generation);
    else surface.complete(message);
  });
}

/** 缺省使用可信 Host→window 绑定；显式目标只从 Main 当前窗口注册表解析。 */
export function bindAppControlNavigationHost(
  win: BrowserWindow,
  host: UtilityProcess,
  findWindow: (id: number) => BrowserWindow | null = (id) => (id === win.id ? win : null),
): () => void {
  const pending = new Map<string, AppControlNavigationWindow>();
  const source: AppNavigationSource = {
    reply: (message) => {
      pending.delete(message.requestId);
      host.postMessage(message);
    },
  };
  const receiveHostMessage = (payload: unknown) => {
    const cancel = hostAppNavigationCancelResponseSchema.safeParse(payload);
    if (cancel.success) {
      pending.get(cancel.data.requestId)?.cancel(source, cancel.data.requestId);
      return;
    }
    const opened = hostAppNavigationOpenResponseSchema.safeParse(payload);
    if (!opened.success) return;
    const message = opened.data;
    const explicit = message.uiTarget?.match(/^window:([1-9][0-9]*)$/u);
    // 显式目标缺失/失效时不回落到当前窗口，避免把导航送到错误窗口。
    const target = message.uiTarget ? (explicit ? findWindow(Number(explicit[1])) : null) : win;
    if (!target || target.isDestroyed()) {
      source.reply({
        type: "app-navigation-result",
        requestId: message.requestId,
        result: { status: "unavailable", reason: "ui-target-unavailable" },
      });
      return;
    }
    const surface = windowSurface(target);
    pending.set(message.requestId, surface);
    surface.open(source, message);
  };
  // Host→Main 只处理 open/cancel；真实回执由 renderer IPC 进入 surface.complete，
  // 再由 source.reply 通过父端口回到 Host。Main 不是导航 owner。
  host.on("message", receiveHostMessage);
  return () => {
    host.removeListener("message", receiveHostMessage);
    for (const surface of new Set(pending.values())) surface.detach(source);
    pending.clear();
  };
}
