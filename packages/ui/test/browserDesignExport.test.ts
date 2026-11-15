import { describe, expect, it, vi } from "vitest";
import type {
  CaptureBrowserGuestPageRequest,
  CaptureBrowserGuestPageResult,
  IPlatformService,
  PrintBrowserGuestPageRequest,
  PrintBrowserGuestPageResult,
  SaveFileRequest,
  SaveFileResult,
} from "@zcode/shared";
import {
  canExportBrowserDesignElement,
  canExportBrowserDesignPage,
  exportBrowserDesignPage,
  isSameBrowserDesignExportSnapshot,
  parseBrowserDesignViewport,
  readBrowserDesignViewport,
  resolveBrowserDesignPlatformPort,
  type BrowserDesignExportPort,
  type BrowserDesignExportSnapshot,
} from "../src/browser-use/browserDesignExport.js";

// 公共契约（@zcode/shared）驱动的导出端口测试：请求/结果类型不允许私有同形状结构。
// 这里验证 UI 送给平台的是真正的 request（含 clip 与 viewport），以及 stale/越界/IO 失败语义。

const snapshot: BrowserDesignExportSnapshot = {
  guest: { webContentsId: 42, title: "My Page / draft" },
  scope: {
    browserKey: "tab-1",
    sessionId: "session-1",
    workspaceKey: "/tmp/ws",
    residencyGeneration: 3,
    webviewGeneration: 2,
  },
};

function createPlatform(overrides: Partial<IPlatformService>): IPlatformService {
  return {
    selectDirectory: async () => null,
    selectFile: async () => null,
    openInEditor: async () => ({ success: true }),
    executeDesktopCommand: async () => undefined,
    getInstalledEditors: async () => [],
    ...overrides,
  } as IPlatformService;
}

function createPort(overrides: Partial<BrowserDesignExportPort> = {}) {
  const captureBrowserGuestPage = vi.fn(
    async (_request: CaptureBrowserGuestPageRequest): Promise<CaptureBrowserGuestPageResult> => ({
      success: true,
      data: new Uint8Array([1, 2, 3]).buffer,
    }),
  );
  const printBrowserGuestPage = vi.fn(
    async (_request: PrintBrowserGuestPageRequest): Promise<PrintBrowserGuestPageResult> => ({
      success: true,
      data: new Uint8Array([37, 80, 68, 70]).buffer,
    }),
  );
  const saveFile = vi.fn(
    async (_request: SaveFileRequest): Promise<SaveFileResult> => ({
      success: true,
      path: "/tmp/out",
    }),
  );
  const port: BrowserDesignExportPort = {
    captureBrowserGuestPage,
    printBrowserGuestPage,
    saveFile,
    ...overrides,
  };
  return { captureBrowserGuestPage, port, printBrowserGuestPage, saveFile };
}

describe("browser design export port", () => {
  it("only exposes platform methods that really exist (no private request shape)", () => {
    const empty = resolveBrowserDesignPlatformPort(createPlatform({}));
    expect(empty).toEqual({});

    const capture = vi.fn(async () => ({ success: true }) as CaptureBrowserGuestPageResult);
    const print = vi.fn(async () => ({ success: true }) as PrintBrowserGuestPageResult);
    const save = vi.fn(async () => ({ success: true, path: "/x" }) as SaveFileResult);
    const port = resolveBrowserDesignPlatformPort(
      createPlatform({
        captureBrowserGuestPage: capture,
        printBrowserGuestPage: print,
        saveFile: save,
      }),
    );
    expect(Object.keys(port).sort()).toEqual([
      "captureBrowserGuestPage",
      "printBrowserGuestPage",
      "saveFile",
    ]);
  });

  it("gates page/element capability on the real public port and a valid guest id", () => {
    const { port } = createPort();
    expect(canExportBrowserDesignPage({ guest: snapshot.guest, kind: "png", port })).toBe(true);
    expect(canExportBrowserDesignPage({ guest: snapshot.guest, kind: "pdf", port })).toBe(true);
    expect(
      canExportBrowserDesignPage({
        guest: { ...snapshot.guest, webContentsId: 0 },
        kind: "png",
        port,
      }),
    ).toBe(false);
    expect(
      canExportBrowserDesignPage({
        guest: snapshot.guest,
        kind: "png",
        port: { saveFile: port.saveFile },
      }),
    ).toBe(false);
    expect(
      canExportBrowserDesignElement({
        elementRect: { x: 1, y: 2, width: 3, height: 4 },
        guest: snapshot.guest,
        port,
      }),
    ).toBe(true);
    expect(
      canExportBrowserDesignElement({
        elementRect: { x: 1, y: 2, width: 0, height: 4 },
        guest: snapshot.guest,
        port,
      }),
    ).toBe(false);
    expect(canExportBrowserDesignElement({ elementRect: null, guest: snapshot.guest, port })).toBe(
      false,
    );
  });

  it("captures the full page and saves the PNG bytes with a sanitized name", async () => {
    const { captureBrowserGuestPage, port, saveFile } = createPort();
    const result = await exportBrowserDesignPage({
      isCurrent: () => true,
      kind: "png",
      port,
      readViewport: async () => ({ width: 800, height: 600 }),
      snapshot,
    });
    expect(result).toEqual({ status: "saved", path: "/tmp/out" });
    expect(captureBrowserGuestPage).toHaveBeenCalledWith({ webContentsId: 42 });
    const saved = saveFile.mock.calls[0]?.[0];
    expect(saved?.suggestedName).toBe("My Page draft.png");
    expect(saved?.data).toBeInstanceOf(ArrayBuffer);
  });

  it("sends the inspected element rect as CSS clip with the measured viewport", async () => {
    const { captureBrowserGuestPage, port } = createPort();
    const executeJs = vi.fn(async () => ({ width: 800, height: 600 }));
    const viewport = await readBrowserDesignViewport(executeJs);
    expect(viewport).toEqual({ width: 800, height: 600 });
    await exportBrowserDesignPage({
      elementRect: { x: 10, y: 20, width: 120, height: 40 },
      isCurrent: () => true,
      kind: "png",
      port,
      readViewport: async () => viewport,
      snapshot,
    });
    expect(captureBrowserGuestPage.mock.calls[0]?.[0]).toEqual({
      webContentsId: 42,
      clip: {
        x: 10,
        y: 20,
        width: 120,
        height: 40,
        viewportWidth: 800,
        viewportHeight: 600,
      },
    });
  });

  it("lets Main judge out-of-view clips instead of clamping them", async () => {
    const { port, saveFile } = createPort({
      captureBrowserGuestPage: async () => ({ success: false, error: "clip_out_of_view" }),
    });
    const result = await exportBrowserDesignPage({
      elementRect: { x: -40, y: 10, width: 60, height: 30 },
      isCurrent: () => true,
      kind: "png",
      port,
      readViewport: async () => ({ width: 800, height: 600 }),
      snapshot,
    });
    expect(result).toEqual({ status: "failed", error: "clip_out_of_view" });
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("drops late results when the tab/guest generation changed", async () => {
    const { port, saveFile } = createPort();
    const result = await exportBrowserDesignPage({
      isCurrent: () => false,
      kind: "png",
      port,
      readViewport: async () => ({ width: 800, height: 600 }),
      snapshot,
    });
    expect(result).toEqual({ status: "stale" });
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("compares owner/session/tab/generation for stale detection", () => {
    expect(isSameBrowserDesignExportSnapshot(snapshot, { ...snapshot })).toBe(true);
    expect(
      isSameBrowserDesignExportSnapshot(snapshot, {
        guest: snapshot.guest,
        scope: { ...snapshot.scope, webviewGeneration: 3 },
      }),
    ).toBe(false);
    expect(
      isSameBrowserDesignExportSnapshot(snapshot, {
        guest: { ...snapshot.guest, webContentsId: 43 },
        scope: snapshot.scope,
      }),
    ).toBe(false);
  });

  it("exports PDF through the real print port, never a webview method", async () => {
    const { port, printBrowserGuestPage, saveFile } = createPort();
    const result = await exportBrowserDesignPage({
      isCurrent: () => true,
      kind: "pdf",
      port,
      readViewport: async () => null,
      snapshot,
    });
    expect(result).toEqual({ status: "saved", path: "/tmp/out" });
    expect(printBrowserGuestPage).toHaveBeenCalledWith({ webContentsId: 42 });
    expect(saveFile.mock.calls[0]?.[0]?.suggestedName).toBe("My Page draft.pdf");
  });

  it("reports unavailable/failed without fabricating a saved file", async () => {
    const noSave = await exportBrowserDesignPage({
      isCurrent: () => true,
      kind: "pdf",
      port: { printBrowserGuestPage: async () => ({ success: true, data: new ArrayBuffer(1) }) },
      readViewport: async () => null,
      snapshot,
    });
    expect(noSave).toEqual({ status: "unavailable", kind: "pdf" });

    const invalidGuest = await exportBrowserDesignPage({
      isCurrent: () => true,
      kind: "png",
      port: createPort().port,
      readViewport: async () => null,
      snapshot: { guest: { ...snapshot.guest, webContentsId: 0 }, scope: snapshot.scope },
    });
    expect(invalidGuest).toEqual({ status: "failed", error: "guest_not_ready" });

    const canceled = createPort({
      saveFile: async () => ({ success: false, canceled: true }),
    });
    expect(
      await exportBrowserDesignPage({
        isCurrent: () => true,
        kind: "png",
        port: canceled.port,
        readViewport: async () => null,
        snapshot,
      }),
    ).toEqual({ status: "canceled" });
  });

  it("rejects forged viewport readings from the page", () => {
    expect(parseBrowserDesignViewport({ width: 0, height: 10 })).toBeNull();
    expect(parseBrowserDesignViewport({ width: 10, height: Number.NaN })).toBeNull();
    expect(parseBrowserDesignViewport({ width: "10", height: 10 })).toBeNull();
    expect(parseBrowserDesignViewport(null)).toBeNull();
  });
});
