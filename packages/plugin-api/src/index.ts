/**
 * 插件作者使用的类型入口。运行时不存在：扩展进程由宿主加载，能力经 loopback 调用。
 * 契约的真实定义在 `@zcode/shared/extension-host`，这里只做面向插件作者的稳定子路径。
 */
export type {
  ExtensionActivate,
  ExtensionContext,
  ExtensionHostClient,
  ExtensionHostError,
  ExtensionSessionsContext,
} from "@zcode/shared/extension-host/sdk";
export type {
  ExtensionCapabilityTable,
  CapabilityId,
  CapabilityInput,
  CapabilityOutput,
} from "@zcode/shared/extension-host";
export { defineExtension } from "@zcode/shared/extension-host/sdk";
