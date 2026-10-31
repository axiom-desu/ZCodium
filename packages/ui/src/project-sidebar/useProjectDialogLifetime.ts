import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { ProjectSidebarScope } from "./useProjectSidebarData.js";

/** 只拥有打开实例的存活性；树/服务资格仍由唯一 readTree owner 判定。 */
export function useProjectDialogLifetime(
  open: boolean,
  { token, isCurrentToken }: ProjectSidebarScope,
  instanceKey?: string,
): () => boolean {
  const lifetime = useMemo(() => ({ alive: true }), [open, token, instanceKey]);
  const current = useRef(lifetime);
  current.current = lifetime;
  useLayoutEffect(() => {
    lifetime.alive = true;
    return () => {
      lifetime.alive = false;
    };
  }, [lifetime]);
  // captured epoch 自比永远成立；必须在 await 后同时读取当前实例 ref 和 owner。
  return useCallback(
    () => open && lifetime.alive && current.current === lifetime && isCurrentToken(token),
    [isCurrentToken, lifetime, open, token],
  );
}
