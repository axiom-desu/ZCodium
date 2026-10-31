import { Loader2, PuzzleIcon } from "lucide-react";
import { useEffect } from "react";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { toast } from "@/components/ui/toast.js";
import type { OpenPluginUiSideTabRequest } from "@/plugin-ui/contract.js";
import { useRecommendedUiPlugins } from "@/plugin-ui/adapters/useRecommendedUiPlugins.js";
import { resolvePluginUiSurfaceTitle } from "@/plugin-ui/adapters/usePluginUiSurfaces.js";
import { resolveItemDisplayName } from "@/settings/pluginStoreListing.js";

export interface PluginUiLauncherItemsProps {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** 正式会话 id；草稿态为 null，此时不显示入口（面板是会话级，第一版不支持草稿）。 */
  sessionId: string | null;
  onOpenPluginUi: (request: OpenPluginUiSideTabRequest) => void;
  /** 与"打开标签页"其它按钮同一套样式，由 AnimatedSidePanePanel 传入。 */
  itemClassName: string;
}

export function buildPluginUiLauncherItemId(pluginId: string, surfaceId: string): string {
  return `plugin-ui:${pluginId}/${surfaceId}`;
}

/**
 * "打开标签页"里的插件面板入口，与内建项共用列表/网格。
 * 推荐只是目录曝光；安装/启用必须由用户点击触发，成功也不替用户自动打开面板。
 */
export function PluginUiLauncherItems(props: PluginUiLauncherItemsProps) {
  const { intl, locale } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const {
    entries,
    loading,
    prepare,
    resolveSurface,
    isBusy: isPluginBusy,
    error,
  } = useRecommendedUiPlugins({
    workspacePath: props.workspacePath,
    workspaceIdentity: props.workspaceIdentity,
    remoteSessionId: props.remoteSessionId,
    sessionId: props.sessionId,
  });
  useEffect(() => {
    if (error) toast(error, { variant: "warning" });
  }, [error]);
  if (props.sessionId === null || (loading && entries.length === 0)) return null;
  if (entries.length === 0) {
    return (
      <p className="text-ui-base text-foreground-subtle" data-testid="side-pane-ui-empty">
        {intl.formatMessage({ id: "sidePane.launcher.empty" })}
      </p>
    );
  }
  const sessionId = props.sessionId;
  return (
    <>
      {entries.map(({ pluginId, surfaceId, item }) => {
        const surface = item.info?.uiSurfaces?.find((candidate) => candidate.id === surfaceId);
        const title = surface
          ? resolvePluginUiSurfaceTitle(surface.title, locale)
          : resolveItemDisplayName(item, locale);
        const itemId = buildPluginUiLauncherItemId(pluginId, surfaceId);
        // 忙碌只按当前插件计算；安装 A 时 B 仍可点击。
        const isBusy = isPluginBusy(item);
        const actionLabel = intl.formatMessage({
          id: isBusy
            ? "common.loading"
            : !item.installed
              ? "settings.plugins.store.install"
              : !item.info?.enabled
                ? "settings.plugins.store.menu.enable"
                : "settings.plugins.store.ui.open",
        });
        const open = async () => {
          if (!item.installed || !item.info?.enabled) {
            await prepare(item);
            return;
          }
          if (
            !platform?.pluginSandbox ||
            props.remoteSessionId ||
            isRemoteWorkspaceIdentity(props.workspaceIdentity ?? "")
          ) {
            toast(intl.formatMessage({ id: "settings.plugins.store.ui.unsupported" }));
            return;
          }
          const resolved = await resolveSurface(pluginId, surfaceId);
          // undefined = 入口已经切换；不导航、不弹“不可用”。
          if (resolved === undefined) return;
          if (!resolved) {
            toast(intl.formatMessage({ id: "settings.plugins.store.ui.unavailable" }));
            return;
          }
          props.onOpenPluginUi({
            parentSessionId: sessionId,
            surfaceId: resolved.id,
            serverName: resolved.server,
            pluginId: resolved.pluginId,
            resourceUri: resolved.resourceUri,
            title: resolvePluginUiSurfaceTitle(resolved.title, locale),
            workspacePath: props.workspacePath,
            ...(props.workspaceIdentity ? { workspaceIdentity: props.workspaceIdentity } : {}),
            remoteSessionId: props.remoteSessionId ?? null,
          });
        };
        return (
          <button
            key={itemId}
            type="button"
            data-side-pane-open-tab-item={itemId}
            className={props.itemClassName}
            onClick={() => void open()}
            disabled={isBusy}
            aria-busy={isBusy || undefined}
          >
            {isBusy ? (
              <Loader2 className="size-4 animate-spin text-foreground-subtle" aria-hidden="true" />
            ) : (
              <PuzzleIcon className="size-4 text-foreground-subtle" />
            )}
            <span className="side-pane-open-tab-button-label min-w-0 flex-1 truncate text-left">
              {title}
            </span>
            <span className="truncate text-ui-sm text-foreground-subtlest">{actionLabel}</span>
          </button>
        );
      })}
    </>
  );
}
