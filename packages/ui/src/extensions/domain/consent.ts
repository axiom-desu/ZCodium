import type { ExtensionGrant } from "@zcode/shared/extension-host";
import type { ExtensionSlotViewState } from "../contract.js";

/**
 * 授权请求的纯判定：提交的必须是当前投影里**声明**的档位。
 *
 * 不追加 granted/recorded（旧授权不能隐式扩张），也不按档位链补齐 read：
 * sessions.write 已覆盖 sessions.read，规范化后的声明就是最小集合。
 */
export function consentGrantRequest(plugin: ExtensionSlotViewState["pending"][number]): {
  pluginId: string;
  grants: ExtensionGrant[];
} {
  return { pluginId: plugin.pluginId, grants: [...plugin.declared] };
}
