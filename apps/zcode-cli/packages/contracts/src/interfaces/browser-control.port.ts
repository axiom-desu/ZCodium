/**
 * BrowserControlPort —— agent 侧浏览器控制端口。
 *
 * browser-client 库把 agent.browsers.* 的每个调用构造成 BrowserCommand，经此端口执行；
 * 实现（ProtocolBrowserControlBroker）把它翻译成 ZCode Protocol 的
 * interaction/browserExecute 反向请求，由 app（host→main WebContentsView/CDP）执行。
 *
 * 类型说明：BrowserCommand/BrowserCommandResult 与 @zcode/shared 的 browser-use 契约同构。
 * 此处定义结构镜像（不 import @zcode/shared，避免 agent contracts 的 zod v3 与 shared zod v4
 * 跨包耦合）；协议边界用 shared 的 zod schema 做运行时校验，两侧一致性由 round-trip 测保证。
 */

export * from "./browser-control/context.js";
export * from "./browser-control/commands.js";
export * from "./browser-control/results.js";
export * from "./browser-control/port.js";
