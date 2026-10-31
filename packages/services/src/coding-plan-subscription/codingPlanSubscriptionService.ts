import type { ApiClient, DynamicWorkflowClientConfig, DynamicWorkflowMode } from "@zcode/shared";
import {
  buildRuntimeZCodeApiUrl,
  ZCODE_VERSION,
  normalizeDynamicWorkflowMode,
  resolveDynamicWorkflowClientConfig,
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
} from "@zcode/shared";
import { readApiJson } from "../providers/api/apiJson.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { ICodingPlanSubscriptionService } from "./codingPlanSubscription.js";

const CLIENT_CONFIG_CACHE_TTL_MS = 60 * 60 * 1000;
const log = createServiceLogger("codingPlanSubscription");

interface ClientConfigEnvelope {
  data?: {
    configs?: {
      dynamicWorkflow?: { mode?: unknown } | null;
    } | null;
  } | null;
}

export function createCodingPlanSubscriptionService(dependencies: {
  apiClient: ApiClient;
  /**
   * 用户选择（launch.md「The user's choice」）的读取方，每次调用现读：
   *   - 本机设置权威：读 setting.json 的 `dynamicWorkflowMode`；
   *   - desktop-attached remote Host：读 desktop 推来的值（没有本机设置权威）。
   * 缺失 = 没有用户选择，生效值只由「提供」决定。
   */
  resolveDynamicWorkflowUserMode?: () => Promise<unknown>;
  /** 执行端 DWF 引擎能力；缺失按 supported，见 resolveDynamicWorkflowEngineSupport。 */
  resolveDynamicWorkflowEngineSupport?: () => "supported" | "unsupported";
}): ICodingPlanSubscriptionService {
  let snapshot: ClientConfigEnvelope | null = null;
  let expiresAt = 0;
  let request: Promise<ClientConfigEnvelope> | null = null;

  async function resolveUserMode(): Promise<DynamicWorkflowMode | undefined> {
    const read = dependencies.resolveDynamicWorkflowUserMode;
    if (!read) return undefined;
    try {
      return normalizeDynamicWorkflowMode(await read());
    } catch (error) {
      // 设置读失败不能把功能关掉，也不能让快照读取抛错：按「跟随服务端」处理。
      log.warn(undefined, "动态工作流用户选择读取失败，按跟随服务端处理", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async function resolveConfig(remote: unknown): Promise<DynamicWorkflowClientConfig> {
    const userMode = await resolveUserMode();
    return resolveDynamicWorkflowClientConfig({
      remote,
      env: process.env,
      ...(userMode ? { userMode } : {}),
      ...(dependencies.resolveDynamicWorkflowEngineSupport
        ? { engine: dependencies.resolveDynamicWorkflowEngineSupport() }
        : {}),
    });
  }

  async function getClientConfigs(): Promise<ClientConfigEnvelope> {
    if (snapshot && expiresAt > Date.now()) return snapshot;
    if (request) return request;
    const url = new URL(buildRuntimeZCodeApiUrl(process.env, "/api/v1/client/configs"));
    url.searchParams.set("app_version", ZCODE_VERSION);
    url.searchParams.set("platform", `${process.platform}-${process.arch}`);
    request = readApiJson<ClientConfigEnvelope>(dependencies.apiClient, url, {
      method: "GET",
      timeoutMs: 15_000,
    });
    try {
      snapshot = await request;
      expiresAt = Date.now() + CLIENT_CONFIG_CACHE_TTL_MS;
      return snapshot;
    } finally {
      request = null;
    }
  }

  return {
    async getDynamicWorkflowClientConfig(options?: {
      forceRefresh?: boolean;
    }): Promise<DynamicWorkflowClientConfig> {
      if (normalizeDynamicWorkflowMode(process.env[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV])) {
        return await resolveConfig(undefined);
      }
      if (options?.forceRefresh) {
        snapshot = null;
        expiresAt = 0;
      }
      try {
        const payload = await getClientConfigs();
        return await resolveConfig(payload.data?.configs?.dynamicWorkflow);
      } catch (error) {
        log.warn(undefined, "动态工作流灰度配置读取失败，按关闭处理", {
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        // 远端失败仍要套用户选择：离线启动的 Host 不能连用户明确打开的功能一起关掉。
        return await resolveConfig(undefined);
      }
    },
  };
}
