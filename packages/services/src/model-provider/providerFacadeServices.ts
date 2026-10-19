import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import {
  type ModelConfigObject,
  type ModelId,
  type ModelSelection,
  type ModelSelectionFacade,
  type ModelSelectionView,
  type ModelSelectionViewInput,
  type ProviderConfigObject,
  type ProviderId,
  type ProviderSettingsFacade,
  type ProviderSettingsCreationResult,
  type ModelConfigResolution,
  type ProviderSettingsView,
  type ResolveModelConfigInput,
  type SavePersonalModelDraftInput,
  isApiKeyAccess,
} from "@zcode/provider";
import { createServiceDescriptor } from "../descriptors.js";
import type { ModelConnectivityResult } from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type {
  ProviderModelCatalogFailure,
  ProviderModelCatalogLister,
  ProviderModelCatalogResult,
} from "./providerModelCatalog.js";

export type {
  ProviderSettingsProviderView,
  ModelSelectionView,
  ModelSelectionViewInput,
  ProviderSettingsView,
} from "@zcode/provider";

export type {
  ProviderModelCatalogMetadata,
  ProviderModelCatalogResult,
} from "./providerModelCatalog.js";

export interface IProviderSettingsService {
  readonly onDidChange: Event<ProviderSettingsView>;
  getView(): Promise<ProviderSettingsView>;
  refresh(reason: string): Promise<ProviderSettingsView>;
  createPersonalProvider(
    input?: Parameters<ProviderSettingsFacade["createPersonalProvider"]>[0],
  ): Promise<ProviderSettingsCreationResult>;
  resolveModelConfig(input: ResolveModelConfigInput): Promise<ModelConfigResolution>;
  savePersonalProviderOverlay(
    providerId: ProviderId,
    config: ProviderConfigObject,
    metadata?: Parameters<ProviderSettingsFacade["savePersonalProviderOverlay"]>[2],
  ): Promise<ProviderSettingsView>;
  deletePersonalProvider(providerId: ProviderId): Promise<ProviderSettingsView>;
  reorderPersonalProviders(providerIds: readonly ProviderId[]): Promise<ProviderSettingsView>;
  reorderPersonalModels(
    providerId: ProviderId,
    modelIds: readonly ModelId[],
  ): Promise<ProviderSettingsView>;
  addPersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    config: ModelConfigObject,
    useRecommendedConfig?: boolean,
  ): Promise<ProviderSettingsView>;
  renamePersonalModel(
    providerId: ProviderId,
    currentModelId: ModelId,
    nextModelId: ModelId,
  ): Promise<ProviderSettingsView>;
  deletePersonalModel(providerId: ProviderId, modelId: ModelId): Promise<ProviderSettingsView>;
  savePersonalModelDraft(input: SavePersonalModelDraftInput): Promise<ProviderSettingsView>;
  setPersonalModelEnabled(
    providerId: ProviderId,
    modelId: ModelId,
    enabled: boolean,
  ): Promise<ProviderSettingsView>;
  /** 测试已经保存并进入目标 Environment Registry 的正式 Model。 */
  testModelConnectivity(
    input: ProviderSettingsConnectivityRequest,
  ): Promise<ModelConnectivityResult>;
  /** 读取 API Key 型 Provider 自己的模型目录，返回候选 modelId（不落库）。 */
  listProviderModels(input: ListProviderModelsInput): Promise<ProviderModelCatalogResult>;
}

/** Renderer 侧入口参数：只描述“哪个 Environment 的哪个 Provider”。 */
export interface ListProviderModelsInput {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly providerId: ProviderId;
}

export const IProviderSettingsService = createServiceDescriptor<IProviderSettingsService>(
  ServiceChannels.ProviderSettings,
);

export interface ProviderSettingsConnectivityTestInput {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
}

export interface ProviderSettingsConnectivityRequest {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
}

export type ProviderSettingsConnectivityTester = (
  input: ProviderSettingsConnectivityTestInput,
) => Promise<ModelConnectivityResult>;

export interface IModelSelectionService {
  readonly onDidChange: Event<ModelSelectionView>;
  getView(input?: ModelSelectionViewInput): Promise<ModelSelectionView>;
}

export interface ModelSelectionConfiguredDefaultSource {
  read(): Promise<ModelSelection | undefined>;
  onDidChange?(listener: () => void): () => void;
}

export const IModelSelectionService = createServiceDescriptor<IModelSelectionService>(
  ServiceChannels.ModelSelection,
);

export function createProviderSettingsService(
  facade: ProviderSettingsFacade,
  ensureReady: () => Promise<void> = async () => {},
  testConnectivity?: ProviderSettingsConnectivityTester,
  listProviderModels?: ProviderModelCatalogLister,
): IProviderSettingsService {
  const log = createServiceLogger("provider-settings");
  return {
    onDidChange: toEvent((listener) => facade.onDidChange(listener)),
    getView: async () => {
      await ensureReady();
      return facade.getView();
    },
    refresh: async (reason) => {
      await ensureReady();
      return facade.refresh(reason);
    },
    createPersonalProvider: async (input) => {
      await ensureReady();
      return facade.createPersonalProvider(input);
    },
    resolveModelConfig: async (input) => {
      await ensureReady();
      return facade.resolveModelConfig(input);
    },
    savePersonalProviderOverlay: async (providerId, config, metadata) => {
      await ensureReady();
      return facade.savePersonalProviderOverlay(providerId, config, metadata);
    },
    deletePersonalProvider: async (providerId) => {
      await ensureReady();
      return facade.deletePersonalProvider(providerId);
    },
    reorderPersonalProviders: async (providerIds) => {
      await ensureReady();
      return facade.reorderPersonalProviders(providerIds);
    },
    reorderPersonalModels: async (providerId, modelIds) => {
      await ensureReady();
      return facade.reorderPersonalModels(providerId, modelIds);
    },
    addPersonalModel: async (providerId, modelId, config, useRecommendedConfig) => {
      await ensureReady();
      return facade.addPersonalModel(providerId, modelId, config, useRecommendedConfig);
    },
    renamePersonalModel: async (providerId, currentModelId, nextModelId) => {
      await ensureReady();
      return facade.renamePersonalModel(providerId, currentModelId, nextModelId);
    },
    deletePersonalModel: async (providerId, modelId) => {
      await ensureReady();
      return facade.deletePersonalModel(providerId, modelId);
    },
    savePersonalModelDraft: async (input) => {
      await ensureReady();
      return facade.savePersonalModelDraft(input);
    },
    setPersonalModelEnabled: async (providerId, modelId, enabled) => {
      await ensureReady();
      return facade.setPersonalModelEnabled(providerId, modelId, enabled);
    },
    testModelConnectivity: async (input) => {
      await ensureReady();
      if (!testConnectivity) {
        throw new Error("当前 Environment 未装配模型连通性测试能力");
      }
      await facade.waitForProviderOperations(input.providerId);
      // 禁用对象仍存在于配置视图，但不进入执行 Registry；不能把未发布误报成配置丢失。
      // 只消费操作完成后的公共资格，不另查 Key、权益，也不替代目标 Environment 最终校验。
      const provider = facade
        .getView()
        .providers.find((item) => item.providerId === input.providerId);
      const model = provider?.models.find((item) => item.modelId === input.modelId);
      const unavailable =
        !provider || !provider.enabled
          ? "provider-unavailable"
          : !model || !model.enabled || model.issues.length > 0
            ? "model-unavailable"
            : !provider.executable
              ? "provider-unavailable"
              : !model.executable
                ? "model-unavailable"
                : undefined;
      if (unavailable) {
        return {
          success: false,
          error: {
            code: unavailable,
            message:
              unavailable === "provider-unavailable"
                ? "This provider is currently unavailable for connectivity testing."
                : "This model is currently unavailable for connectivity testing.",
          },
        };
      }
      return testConnectivity({
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        providerId: input.providerId,
        modelId: input.modelId,
      });
    },
    listProviderModels: async (input) => {
      await ensureReady();
      if (!listProviderModels) {
        throw new Error("当前 Environment 未装配模型目录读取能力");
      }
      // 与连通性测试同一队列边界：卡片草稿刚 flush 完的 baseUrl/apiKey 必须已进入视图，
      // 否则会用旧配置发起请求。禁用对象仍在视图里，提前拒绝比发错请求更明确。
      await facade.waitForProviderOperations(input.providerId);
      const provider = facade
        .getView()
        .providers.find((item) => item.providerId === input.providerId);
      if (!provider) {
        return {
          success: false,
          error: {
            code: "provider-unavailable",
            message: `Provider 不存在: ${input.providerId}`,
          },
        } satisfies ProviderModelCatalogFailure;
      }
      const access = provider.effectiveConfig.access;
      // 账号型 Provider 的模型由权益接口决定，不读 /models。
      if (!access || !isApiKeyAccess(access)) {
        return {
          success: false,
          error: { code: "unsupported-access", message: "only api-key providers are supported" },
        } satisfies ProviderModelCatalogFailure;
      }
      const baseUrl = provider.effectiveConfig.api?.baseUrl?.trim();
      if (!baseUrl) {
        return {
          success: false,
          error: { code: "base-url-missing", message: "provider baseUrl is missing" },
        } satisfies ProviderModelCatalogFailure;
      }
      const apiKey = access.apiKey?.trim() ?? "";
      const headers = provider.effectiveConfig.api?.headers ?? null;
      // 无 Key 且无自定义鉴权头时请求必然 401；本地拒绝即可，不浪费一次往返。
      if (!apiKey && !headers) {
        return {
          success: false,
          error: { code: "api-key-missing", message: "provider apiKey is missing" },
        } satisfies ProviderModelCatalogFailure;
      }
      try {
        return await listProviderModels({
          apiType: provider.effectiveConfig.api?.type ?? "openai-chat-completions",
          baseUrl,
          apiKey,
          headers,
        });
      } catch (error) {
        log.warn(undefined, `provider model catalog request failed: ${String(error)}`);
        return {
          success: false,
          error: { code: "request-failed", message: "request failed" },
        } satisfies ProviderModelCatalogFailure;
      }
    },
  };
}

export function createModelSelectionService(
  facade: ModelSelectionFacade,
  ensureReady: () => Promise<void> = async () => {},
  configuredDefaultSource?: ModelSelectionConfiguredDefaultSource,
): IModelSelectionService & { dispose(): void } {
  const log = createServiceLogger("model-selection");
  let revision = 0;
  let disposed = false;
  const listeners = new Set<(view: ModelSelectionView) => void>();
  const getView = async (input?: ModelSelectionViewInput): Promise<ModelSelectionView> => {
    await ensureReady();
    if (disposed) throw new Error("ModelSelectionService 已 dispose");
    const configuredDefault = await configuredDefaultSource?.read();
    if (disposed) throw new Error("ModelSelectionService 已 dispose");
    const base = facade.getView(configuredDefault);
    if (revision < base.revision) revision = base.revision;
    return facade.getView(configuredDefault, revision, input);
  };
  const emit = (): void => {
    if (disposed) return;
    revision += 1;
    void getView().then(
      (view) => {
        if (disposed) return;
        for (const listener of listeners) listener(view);
      },
      (error: unknown) => {
        // Registry 事件触发的异步 View 重建没有 owner；Host dispose 后它仍会继续
        // 读取已释放的配置仓库，并形成未处理 rejection。dispose 是明确的取消边界；仅在服务
        // 仍存活时记录真实读取失败。
        if (disposed) return;
        log.warn(undefined, `ModelSelection View 刷新失败: ${String(error)}`);
      },
    );
  };
  const disposeFacade = facade.onDidChange(emit);
  const disposeConfiguredDefault = configuredDefaultSource?.onDidChange?.(emit);

  return {
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    getView,
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeFacade();
      disposeConfiguredDefault?.();
      listeners.clear();
    },
  };
}

function toEvent<T>(subscribe: (listener: (event: T) => void) => () => void): Event<T> {
  return (listener) => {
    const dispose = subscribe(listener);
    return { dispose };
  };
}
