import type { PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import { pluginUiPages } from "./pluginUiPageRegistry.js";
import type { Page } from "./pluginUiHostTypes.js";

/**
 * 页面后台执行的窗口级判定：只有资源 `_meta.ui.backgroundRetention: true` 的声明页申请保留；
 * 未声明的页面在握手后立即恢复普通隐藏策略。不接管容量、不创建第二套 page owner。
 */
export function createPluginUiPageRetention(input: {
  page(): Page;
  handle(): Pick<PluginSandboxHandle, "resourceMeta"> | null;
  hasController(): boolean;
  phase(): string;
  ensure(): void;
  hasVisibleAnchor(): boolean;
  setExecutionActive(active: boolean): void;
}) {
  let activityFeed = "";
  let recycling: Promise<boolean> | undefined;
  const retained = () => input.handle()?.resourceMeta?.backgroundRetention === true;
  const syncExecution = () => {
    // 无锚点的冷启动也要完成握手；display:none 会让 Electron guest 无法首次挂载。
    // 仅启动阶段提供不可交互的承载面，握手后未声明的页面立即恢复普通隐藏策略。
    input.setExecutionActive(input.hasController() && (retained() || input.phase() !== "running"));
  };
  const onWindowVisibility = () => {
    if (!document.hidden && input.hasVisibleAnchor()) input.ensure();
    syncExecution();
  };
  return {
    syncExecution,
    onWindowVisibility,
    registerWindowListener() {
      document.addEventListener("visibilitychange", onWindowVisibility);
      return () => document.removeEventListener("visibilitychange", onWindowVisibility);
    },
    /** 新一次工具调用/结果才算活动；同一结果的重复投影不能续期，也不能复活已回收页面。 */
    noteToolFeed(feed: { toolCallId?: string; toolResult?: unknown; toolCancelled?: boolean }) {
      const key = JSON.stringify([feed.toolCallId, Boolean(feed.toolResult), feed.toolCancelled]);
      if (!feed.toolCallId || key === activityFeed) return;
      activityFeed = key;
      pluginUiPages.activity(input.page());
      input.ensure();
    },
    /** 资源显式声明后台保留才进入窗口级保留策略；缺省页面继续走五分钟/容量回收。 */
    prepared(handle: Pick<PluginSandboxHandle, "resourceMeta">) {
      pluginUiPages.prepared(input.page(), handle.resourceMeta?.backgroundRetention === true);
    },
    /**
     * 非强制回收：保留策略与五分钟回收都先向同一窗口 owner 预占名额，再等 Agent 原子裁决 busy/审批。
     * 等待期间被重载或删除的旧 controller 不得释放新实例。
     */
    async recycle(options: {
      starting: boolean;
      current(): unknown;
      disposed(): boolean;
      tryRecycle(): Promise<boolean>;
      release(): Promise<boolean>;
      canReenter(): boolean;
    }): Promise<boolean> {
      if (recycling) return recycling;
      if (options.starting || !pluginUiPages.claimRecycle(input.page())) return false;
      const candidate = options.current();
      const attempt = (async () => {
        if (!(await options.tryRecycle())) return false;
        if (candidate !== options.current() || options.disposed()) return false;
        await options.release();
        // 裁决期间用户可能重新打开；旧凭证已撤销，必须从同一 owner 重建。
        if (options.canReenter()) input.ensure();
        return true;
      })();
      recycling = attempt;
      try {
        return await attempt;
      } finally {
        if (recycling === attempt) recycling = undefined;
        pluginUiPages.finishRecycle(input.page());
      }
    },
  };
}
