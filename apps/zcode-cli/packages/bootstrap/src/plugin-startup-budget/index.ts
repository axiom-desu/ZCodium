import type { PluginLoadOutcome } from "@zcode/contracts";
import type { PluginStartupBudget, PluginStartupBudgetOptions } from "./contract.js";


/** 降级结果必须是可识别的 warning 空结果，不能伪装成“没有插件”。 */
function createPluginStartupFallback(): PluginLoadOutcome {
  return {
    commandRoots: [],
    diagnostics: [
      {
        code: "plugin_startup_timeout",
        severity: "warning",
        message: "Plugin startup timed out. Plugins are unavailable until the Agent restarts.",
      },
    ],
    hooks: {},
    mcpServers: {},
    plugins: [],
    skillRoots: [],
  };
}

/**
 * 进程级插件启动预算：并发调用共享同一截止时间；超时后只返回一次 warning 空结果，
 * 迟到完成被丢弃，不产生未处理拒绝。`dispose` 只结算未决等待，不反注册已完成的插件。
 */
export function createPluginStartupBudget(
  options: PluginStartupBudgetOptions,
): PluginStartupBudget {
  let degraded = false;
  let disposed = false;
  let closeReason: unknown;
  let budget:
    | {
        deadlineAt: number;
        expired: ReturnType<typeof Promise.withResolvers<void>>;
        timer: ReturnType<typeof setTimeout>;
        pending: number;
      }
    | undefined;
  function expire() {
    if (degraded || disposed) return;
    degraded = true;
    budget?.expired.resolve();
    options.onTimeout(
      Object.assign(new Error("Plugin startup timed out"), {
        code: "ZCODE_PLUGIN_STARTUP_TIMEOUT",
      }),
    );
  }
  return {
    get degraded() {
      return degraded;
    },
    async resolvePlugins(resolve) {
      if (disposed) throw closeReason;
      if (degraded) return createPluginStartupFallback();
      if (!budget) {
        budget = {
          deadlineAt: performance.now() + options.timeoutMs,
          expired: Promise.withResolvers<void>(),
          timer: setTimeout(expire, options.timeoutMs),
          pending: 0,
        };
      }
      const active = budget;
      active.pending += 1;
      try {
        const result = await Promise.race([
          resolve(),
          active.expired.promise.then(createPluginStartupFallback),
        ]);
        // 同步摘要计算可能推迟定时器；完成时仍检查预算，不能接受超期结果。
        if (performance.now() >= active.deadlineAt) expire();
        return degraded ? createPluginStartupFallback() : result;
      } catch (error) {
        if (performance.now() >= active.deadlineAt) expire();
        if (degraded && !disposed) return createPluginStartupFallback();
        throw error;
      } finally {
        active.pending -= 1;
        if (active.pending === 0) {
          clearTimeout(active.timer);
          if (budget === active) budget = undefined;
        }
      }
    },
    dispose(reason) {
      disposed = true;
      closeReason = reason;
      if (budget) {
        clearTimeout(budget.timer);
        budget.expired.reject(reason);
      }
    },
  };
}
