import { create } from "zustand";
import type { DataSyncDialogRequest } from "../contract.js";

interface DataSyncDialogStoreState {
  /** 当前弹窗请求；已有实例时只恢复，不替换设备（避免丢失在途推送及其设备身份）。 */
  request: DataSyncDialogRequest | null;
  minimized: boolean;
  /** 推送结束、设备同步状态落盘后递增：入口页据此重新读取，不另存设备结果。 */
  resultVersion: number;
  open(request: DataSyncDialogRequest): void;
  close(): void;
  setMinimized(minimized: boolean): void;
  recordResult(): void;
}

/**
 * 窗口内数据同步弹窗的唯一状态 owner。
 * 所有入口只发 `open(request)`；弹窗组件由 `DataSyncDialogHost` 挂载一次。
 */
export const useDataSyncDialogStore = create<DataSyncDialogStoreState>((set) => ({
  request: null,
  minimized: false,
  resultVersion: 0,
  open: (request) =>
    set((state) =>
      state.request ? { ...state, minimized: false } : { request, minimized: false },
    ),
  close: () => set({ request: null, minimized: false }),
  setMinimized: (minimized) =>
    set((state) => (state.request ? { minimized } : { minimized: false })),
  recordResult: () => set((state) => ({ resultVersion: state.resultVersion + 1 })),
}));

/** 测试用：回到「未打开」基线，避免用例之间串状态。 */
export function openDataSyncDialog(request: DataSyncDialogRequest): void {
  useDataSyncDialogStore.getState().open(request);
}

export function resetDataSyncDialogStore(): void {
  useDataSyncDialogStore.setState({ request: null, minimized: false, resultVersion: 0 });
}
