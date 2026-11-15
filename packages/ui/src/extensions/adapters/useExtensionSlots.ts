import { useEffect, useState } from "react";
import type { ExtensionSlotId } from "@zcode/shared/extension-host";
import type { ExtensionsSnapshot } from "@zcode/services";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { selectSlotView } from "@/extensions/domain/slotSelectors.js";
import { consentGrantRequest } from "@/extensions/domain/consent.js";
import type { ExtensionSlotActions, ExtensionSlotViewState } from "@/extensions/contract.js";

/**
 * 订阅扩展服务投影。快照的唯一来源是 `services/extensions`；hook 只保留最近一次投影
 * 用于渲染，并在服务事件到达时替换，不做本地推断。
 *
 * 手机/Web/旧 Host 没有扩展服务或不支持桌面扩展：available=false，不渲染任何扩展 UI。
 */
export function useExtensionSlots(
  slot: ExtensionSlotId,
): ExtensionSlotViewState & ExtensionSlotActions {
  const platform = useOptionalPlatform();
  const services = useOptionalBaseWorkspaceServices();
  const service = services?.extensionsService;
  const available = Boolean(platform?.pluginSandbox && service);
  const [snapshot, setSnapshot] = useState<ExtensionsSnapshot | null>(null);
  const [loading, setLoading] = useState(available);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!available || !service) {
      setSnapshot(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const subscription = service.onDidChange((next) => {
      if (!cancelled) {
        setSnapshot(next);
        setLoading(false);
      }
    });
    void service
      .getSnapshot()
      .then((next) => {
        if (!cancelled) setSnapshot(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      subscription.dispose();
    };
  }, [available, service]);

  const run = async (action: () => Promise<ExtensionsSnapshot>): Promise<void> => {
    setError(undefined);
    try {
      setSnapshot(await action());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const view = selectSlotView(snapshot, slot, {
    available,
    loading,
    ...(error ? { error } : {}),
  });
  return {
    ...view,
    start: async () => {
      if (service) await run(() => service.start());
    },
    stop: async () => {
      if (service) await run(() => service.stop());
    },
    grant: async (pluginId) => {
      if (!service) return;
      const plugin = snapshot?.plugins.find((candidate) => candidate.pluginId === pluginId);
      if (!plugin) return;
      // 授权对话框展示的档位就是当前声明；声明变化则服务按过期请求拒绝。
      await run(() =>
        service.grant(
          consentGrantRequest({
            pluginId: plugin.pluginId,
            name: plugin.name,
            declared: plugin.declared,
          }),
        ),
      );
    },
    revoke: async (pluginId) => {
      if (service) await run(() => service.revoke(pluginId));
    },
  };
}
