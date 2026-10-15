import { resolveDesktopProductFlavor } from "./desktop-product-identity.mjs";

/**
 * 随包 runtime 资产计划。
 *
 * Rust CLI 资产是否准备/打包必须跟随同一个**有效产品 flavor**：输入是
 * `loadBuiltinProviderConfig()` 解析出的 environment 叠加 process.env，与 tsup 的
 * `__ZCODE_PRODUCT_FLAVOR__`、electron-builder 的 productName/appId 完全同源。
 *
 * 不能只看 `ZCODE_PREVIEW_IDENTITY`：`ZCODE_ENV=test` 本身也解析成 preview
 * （ZCodium Rust），漏掉它会让安装包不带 Rust 资产、但打包后的 Main 默认走 Rust，
 * 首次启动即缺 binary。生产 flavor 也不会因为磁盘残留 Rust 目录而误打包。
 *
 * 这里保持 pure：不做 IO、不读盘、不决定打包顺序，只把「有效 flavor → 是否含 Rust」
 * 收敛成单一函数，供 prepare 脚本与 electron-builder 共用，避免两条平行策略漂移。
 */
export function resolveRuntimeAssetsPlan({ environment, env = process.env } = {}) {
  // 未显式提供有效配置环境时保留传入 env，不能用 undefined 擦掉 production，
  // 否则身份解析会误落到 test/preview 并把 Rust 资产打进正式包。
  const productFlavor = resolveDesktopProductFlavor({
    ...env,
    ZCODE_ENV: environment ?? env.ZCODE_ENV,
  });
  return {
    productFlavor,
    // 生产口味不构建也不打包 Rust；test 后端与显式 preview 身份都属于 preview。
    includeRustCliRuntime: productFlavor === "preview",
  };
}
