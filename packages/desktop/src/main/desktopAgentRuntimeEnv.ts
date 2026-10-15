import type { ZCodeProductFlavor } from "@zcode/shared";

/**
 * Host env 里的 Agent runtime 选择键。
 *
 * Services 侧只读这个键解析命令，不感知 desktop 产品 flavor；产品默认值因此必须由
 * Desktop Main 在 buildHostProcessEnv 里写定，而不是让 Services 反查桌面身份。
 */
export const ZCODE_AGENT_SERVER_RUNTIME_ENV_KEY = "ZCODE_AGENT_SERVER_RUNTIME" as const;

export type ZCodeAgentServerRuntime = "ts" | "zcode-cli-rust";

/** buildHostProcessEnv 注入 Agent runtime 选择的返回形状，保证调用方按已知键读取。 */
export type ZCodeAgentServerRuntimeEnv = {
  [ZCODE_AGENT_SERVER_RUNTIME_ENV_KEY]: string;
};

/**
 * 产品默认 runtime：只有打包的 Preview（ZCodium Rust）默认启用 Rust CLI。
 *
 * 未打包开发态与 production 包沿用 TS，避免把 checkout 的调试产物或磁盘上残留的
 * Rust 资产带进正式版。显式覆盖不走这里。
 */
export function resolveDefaultZCodeAgentServerRuntime(options: {
  isPackaged: boolean;
  productFlavor: ZCodeProductFlavor;
}): ZCodeAgentServerRuntime {
  return options.isPackaged && options.productFlavor === "preview" ? "zcode-cli-rust" : "ts";
}

/**
 * 决定下发给 Host 的 `ZCODE_AGENT_SERVER_RUNTIME`。
 *
 * 优先级：非空显式值 > 产品默认。空/纯空白视为未覆盖并按默认；未知显式值原样透传，
 * 交给既有 Services resolver 明确失败——默认值绝不吞掉无效显式选择。
 */
export function resolveHostProcessAgentServerRuntimeEnv(options: {
  inheritedValue?: string;
  isPackaged: boolean;
  productFlavor: ZCodeProductFlavor;
}): ZCodeAgentServerRuntimeEnv {
  const explicitValue = options.inheritedValue?.trim();
  if (explicitValue) {
    return { [ZCODE_AGENT_SERVER_RUNTIME_ENV_KEY]: explicitValue };
  }
  return {
    [ZCODE_AGENT_SERVER_RUNTIME_ENV_KEY]: resolveDefaultZCodeAgentServerRuntime(options),
  };
}
