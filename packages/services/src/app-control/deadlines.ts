import type { DeadlinePort } from "@zcode/session-control/contracts";

/** 只由 App control 的 wait 使用；不是队列，也不在任何 owner 之外保存状态。 */
export function createDeadlines(): DeadlinePort {
  return {
    create(timeoutMs: number) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let resolve!: () => void;
      const expired = new Promise<void>((yes) => {
        resolve = yes;
        timer = setTimeout(yes, timeoutMs);
      });
      return {
        expired,
        close() {
          if (timer !== undefined) clearTimeout(timer);
          resolve();
        },
      };
    },
  };
}
