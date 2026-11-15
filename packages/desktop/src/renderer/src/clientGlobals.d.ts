/**
 * renderer 直接使用 `window.zcode` / `window.zcodePluginSandbox`；这些平台桥的类型
 * 由 client 包的 globals 子入口声明（package exports `./globals`）。
 * 这里显式引入，避免依赖“恰好被某个模块顺带加载”的隐式全局。
 */
import "@zcode/client/globals";
