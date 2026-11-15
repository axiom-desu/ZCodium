import type { AppControlNavigationPort } from "@zcode/services";
import type { AppNavigationResult, AppNavigationTarget } from "@zcode/shared";

export const APP_NAVIGATION_IPC = "zcode:app-control-navigation";

export type { AppNavigationResult, AppNavigationTarget };

export type AppNavigationOpenInput = Parameters<AppControlNavigationPort["openSession"]>[0];

export type AppNavigationHostMessage =
  | {
      type: "app-navigation-open";
      requestId: string;
      uiTarget?: string;
      target: AppNavigationTarget;
    }
  | { type: "app-navigation-cancel"; requestId: string };

export interface AppNavigationResultMessage {
  type: "app-navigation-result";
  requestId: string;
  result: AppNavigationResult;
}

/** Host 侧回执出口：Main 按实际连接（父端口）投递，不暴露窗口路由。 */
export interface AppNavigationSource {
  reply(message: AppNavigationResultMessage): void;
}

export type AppNavigationRendererMessage =
  | { type: "open"; requestId: string; generation: string; target: AppNavigationTarget }
  | { type: "cancel"; requestId: string; generation: string };

export interface AppNavigationRendererResult {
  requestId: string;
  generation: string;
  result: AppNavigationResult;
}

export interface AppControlNavigationBridge extends AppControlNavigationPort {
  receive(message: AppNavigationResultMessage): void;
  dispose(): void;
}

/** 一个 BrowserWindow 生命周期内的在途关联；不持有 session/项目/已接纳命令状态。 */
export interface AppControlNavigationWindow {
  register(generation: string): void;
  unregister(generation: string): void;
  open(
    source: AppNavigationSource,
    message: Extract<AppNavigationHostMessage, { type: "app-navigation-open" }>,
  ): void;
  cancel(source: AppNavigationSource, requestId: string): void;
  complete(message: AppNavigationRendererResult): void;
  detach(source: AppNavigationSource): void;
  invalidate(): void;
  dispose(): void;
}
