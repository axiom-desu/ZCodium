import { useSyncExternalStore } from "react";

const MOBILE_WEB_VIEWPORT_QUERY = "(max-width: 767px)";

export function readMobileWebViewport(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.dataset.zcodeEntry === "web" &&
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MOBILE_WEB_VIEWPORT_QUERY).matches
  );
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(MOBILE_WEB_VIEWPORT_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

/** 只读浏览器表现事实；useSyncExternalStore 避免首帧与订阅间 resize 丢失，不复制布局/业务状态。 */
export function useMobileWebViewport(): boolean {
  return useSyncExternalStore(subscribe, readMobileWebViewport, () => false);
}
