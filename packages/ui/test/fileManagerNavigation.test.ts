import type { IBroadcastService } from "@zcode/services";
import { beforeEach, describe, expect, it } from "vitest";
import {
  canShowFileManagerNavigation,
  isFileManagerCompactWidth,
  resolveFileManagerNavigationOpen,
  resolveFileManagerWorkspaceKey,
} from "../src/workspace-file-tree/fileManagerNavigation.js";
import {
  createZCodeStore,
  FILE_MANAGER_NAVIGATION_PREFERENCES_STORAGE_KEY,
} from "../src/store/index.js";

// Node 环境没有 DOM：store 初始化只固定主题/字号，不触碰外观 API（根元素没有 hasAttribute，
// syncBrowserThemeSurface 会提前返回），因此这里只补最小可用的 document 与 localStorage。
const localStorageState = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => localStorageState.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageState.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageState.delete(key);
    },
    clear: () => {
      localStorageState.clear();
    },
  },
});

Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    documentElement: {
      classList: { toggle: () => {} },
      style: { setProperty: () => {} },
    },
  },
});

const mockBroadcastService: IBroadcastService = {
  send: async () => {},
  onMessage: () => ({ dispose: () => {} }),
};

function isNavigationOpen(
  store: ReturnType<typeof createZCodeStore>,
  workspaceKey: string,
): boolean {
  return store.getState().fileManagerNavigationOpenByWorkspace[workspaceKey] ?? true;
}

describe("file manager navigation model", () => {
  it("偏好 key 优先使用 trim 后的 identity，同路径不同远端不共用", () => {
    expect(
      resolveFileManagerWorkspaceKey({
        workspaceIdentity: " remote-a ",
        workspacePath: "/workspace/same",
      }),
    ).toBe("remote-a");
    expect(
      resolveFileManagerWorkspaceKey({
        workspaceIdentity: "   ",
        workspacePath: " /workspace/same ",
      }),
    ).toBe("/workspace/same");
    expect(
      resolveFileManagerWorkspaceKey({
        workspaceIdentity: "remote-b",
        workspacePath: "/workspace/same",
      }),
    ).not.toBe(
      resolveFileManagerWorkspaceKey({
        workspaceIdentity: "remote-a",
        workspacePath: "/workspace/same",
      }),
    );
  });

  it("宽布局只看用户偏好，缺席默认展开", () => {
    const base = {
      compactLayout: false,
      compactOverride: null,
      mobileOverlay: false,
      hasSource: false,
    };
    expect(resolveFileManagerNavigationOpen({ ...base, storedPreferenceOpen: undefined })).toBe(
      true,
    );
    expect(resolveFileManagerNavigationOpen({ ...base, storedPreferenceOpen: false })).toBe(false);
    expect(resolveFileManagerNavigationOpen({ ...base, storedPreferenceOpen: true })).toBe(true);
  });

  it("紧凑布局：选中文件后的临时收起优先于偏好，移动 overlay 有文件时让位", () => {
    const compact = {
      compactLayout: true,
      mobileOverlay: false,
      hasSource: true,
    };
    expect(
      resolveFileManagerNavigationOpen({
        ...compact,
        compactOverride: false,
        storedPreferenceOpen: true,
      }),
    ).toBe(false);
    expect(
      resolveFileManagerNavigationOpen({
        ...compact,
        compactOverride: null,
        storedPreferenceOpen: false,
      }),
    ).toBe(false);
    expect(
      resolveFileManagerNavigationOpen({
        ...compact,
        mobileOverlay: true,
        compactOverride: null,
        storedPreferenceOpen: undefined,
      }),
    ).toBe(false);
    expect(
      resolveFileManagerNavigationOpen({
        ...compact,
        mobileOverlay: true,
        hasSource: false,
        compactOverride: null,
        storedPreferenceOpen: undefined,
      }),
    ).toBe(true);
  });

  it("紧凑宽度阈值与目录可见性", () => {
    expect(isFileManagerCompactWidth(383)).toBe(true);
    expect(isFileManagerCompactWidth(384)).toBe(false);
    expect(
      canShowFileManagerNavigation({ workspacePath: "", hasSource: false, sourcePath: null }),
    ).toBe(false);
    expect(
      canShowFileManagerNavigation({ workspacePath: "/w", hasSource: false, sourcePath: null }),
    ).toBe(true);
    expect(
      canShowFileManagerNavigation({ workspacePath: "/w", hasSource: true, sourcePath: "/w/a.ts" }),
    ).toBe(true);
    expect(
      canShowFileManagerNavigation({ workspacePath: "/w", hasSource: true, sourcePath: null }),
    ).toBe(false);
  });
});

describe("file manager navigation preference store", () => {
  beforeEach(() => {
    localStorageState.clear();
  });

  it("同一 workspace 跨 store 重建恢复最后显隐状态", () => {
    const firstStore = createZCodeStore(mockBroadcastService);

    firstStore.getState().setFileManagerNavigationOpen("workspace-a", false);

    expect(isNavigationOpen(firstStore, "workspace-a")).toBe(false);
    expect(isNavigationOpen(createZCodeStore(mockBroadcastService), "workspace-a")).toBe(false);
  });

  it("不同 workspace 各自保存显隐状态", () => {
    const store = createZCodeStore(mockBroadcastService);

    store.getState().setFileManagerNavigationOpen("workspace-a", false);

    expect(isNavigationOpen(store, "workspace-a")).toBe(false);
    expect(isNavigationOpen(store, "workspace-b")).toBe(true);

    store.getState().setFileManagerNavigationOpen("workspace-b", false);
    store.getState().setFileManagerNavigationOpen("workspace-a", true);

    expect(isNavigationOpen(store, "workspace-a")).toBe(true);
    expect(isNavigationOpen(store, "workspace-b")).toBe(false);
  });

  it("同一路径不同远端 identity 的偏好互相隔离", () => {
    const store = createZCodeStore(mockBroadcastService);
    const remoteA = resolveFileManagerWorkspaceKey({
      workspaceIdentity: "remote-a",
      workspacePath: "/workspace/same",
    });
    const remoteB = resolveFileManagerWorkspaceKey({
      workspaceIdentity: "remote-b",
      workspacePath: "/workspace/same",
    });

    store.getState().setFileManagerNavigationOpen(remoteA, false);

    expect(isNavigationOpen(store, remoteA)).toBe(false);
    expect(isNavigationOpen(store, remoteB)).toBe(true);
    expect(isNavigationOpen(store, "/workspace/same")).toBe(true);
  });

  it("空 key 不写入偏好", () => {
    const store = createZCodeStore(mockBroadcastService);

    store.getState().setFileManagerNavigationOpen("   ", false);

    expect(store.getState().fileManagerNavigationOpenByWorkspace).toEqual({});
    expect(localStorageState.get(FILE_MANAGER_NAVIGATION_PREFERENCES_STORAGE_KEY)).toBeUndefined();
  });

  it("损坏或非法持久化数据回退为默认展开", () => {
    localStorageState.set(FILE_MANAGER_NAVIGATION_PREFERENCES_STORAGE_KEY, "not-json");
    expect(isNavigationOpen(createZCodeStore(mockBroadcastService), "workspace-a")).toBe(true);

    localStorageState.set(
      FILE_MANAGER_NAVIGATION_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ "workspace-a": "false", "workspace-b": false }),
    );
    const store = createZCodeStore(mockBroadcastService);

    expect(isNavigationOpen(store, "workspace-a")).toBe(true);
    expect(isNavigationOpen(store, "workspace-b")).toBe(false);
  });
});
