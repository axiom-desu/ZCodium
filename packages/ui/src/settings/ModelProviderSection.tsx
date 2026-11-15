import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toZhOrEnLocale } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { sortModelProvidersForDisplay } from "@/lib/modelProviderOrdering.js";
import {
  getProviderFormApiKeyManagementUrl,
  getProviderFormLabel,
  type ProviderSettingsFormProvider,
} from "@/lib/providerSettingsFormTypes.js";
import {
  addPendingSettingsSectionListener,
  consumePendingSettingsModelProviderTarget,
  type SettingsModelProviderTarget,
} from "@/lib/settingsNavigation.js";
import type { ModelProviderNavGroup } from "./model-provider-section/constants.js";
import { InlineEditableProviderCard } from "./model-provider-section/InlineEditableProviderCard.js";
import { confirmAndDeleteModelProvider } from "./model-provider-section/modelProviderActions.js";
import { ProviderTemplatePicker } from "./model-provider-section/ProviderTemplatePicker.js";
import { ModelProviderSectionLayout } from "./model-provider-section/SectionLayout.js";
import { createCustomProviderNodeKey } from "./model-provider-section/utils.js";

export {
  fuzzyMatch,
  handleEndpointSuggestionPopoverOpenAutoFocus,
  resolveEndpointSuggestionOpenRequest,
} from "./model-provider-section/utils.js";

export function ModelProviderSection({
  workspacePath = "",
  connectivityWorkspacePath,
  connectivityWorkspaceRequired = false,
  pendingModelProviderTarget,
  onConsumePendingModelProviderTarget,
}: {
  workspacePath?: string;
  connectivityWorkspacePath?: string;
  connectivityWorkspaceRequired?: boolean;
  pendingModelProviderTarget?: SettingsModelProviderTarget;
  onConsumePendingModelProviderTarget?: () => void;
} = {}) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const confirmDialog = useConfirmDialog();
  const {
    modelProviders,
    providerTemplates,
    providerSettingsView,
    displayOrder,
    loading,
    loadError,
    reload,
    refreshing,
    refresh,
    saveProvider,
    createPersonalProvider,
    addPersonalModel,
    savePersonalModelDraft,
    setPersonalModelEnabled,
    deletePersonalModel,
    deleteProvider,
    reorderProviderModels,
    saveDisplayOrder,
    reorderableProviderIds,
    testModelConnectivity,
    fetchProviderModels,
  } = useModelProviders({
    workspacePath,
    connectivityWorkspacePath,
    connectivityWorkspaceRequired,
    connectivityUnavailableMessage: intl.formatMessage({
      id: "settings.modelProvider.testModel.localWorkspaceUnavailable",
    }),
  });
  const providers = useMemo(
    () =>
      sortModelProvidersForDisplay(
        // 账号投影不属于用户自己的连接；已有手动 API 配置不按旧 family 分组丢弃。
        modelProviders.filter((provider) => provider.config.access?.type !== "zhipu-account"),
        displayOrder,
      ),
    [displayOrder, modelProviders],
  );
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    () => consumePendingSettingsModelProviderTarget()?.providerId ?? null,
  );
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const navigationIntentRef = useRef(0);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [pendingCreatedProviderId, setPendingCreatedProviderId] = useState<string | null>(null);
  const selectedProvider =
    providers.find((provider) => provider.providerId === selectedProviderId) ?? providers[0];
  const invalidTarget =
    !loading &&
    selectedProviderId !== null &&
    selectedProviderId !== pendingCreatedProviderId &&
    !providers.some((provider) => provider.providerId === selectedProviderId);
  const showPicker = templatePickerOpen || (!loading && providers.length === 0);
  const applyTarget = useCallback((target?: SettingsModelProviderTarget) => {
    navigationIntentRef.current++;
    setSelectedProviderId(target?.providerId ?? null);
    setTemplatePickerOpen(false);
  }, []);
  useEffect(() => {
    if (!pendingModelProviderTarget) return;
    applyTarget(pendingModelProviderTarget);
    onConsumePendingModelProviderTarget?.();
  }, [applyTarget, onConsumePendingModelProviderTarget, pendingModelProviderTarget]);
  useEffect(
    () =>
      addPendingSettingsSectionListener((section, detail) => {
        if (section === "modelProvider")
          applyTarget(detail?.modelProviderId ? { providerId: detail.modelProviderId } : undefined);
      }),
    [applyTarget],
  );
  useEffect(() => {
    if (
      pendingCreatedProviderId &&
      providers.some((provider) => provider.providerId === pendingCreatedProviderId)
    ) {
      setPendingCreatedProviderId(null);
    }
  }, [pendingCreatedProviderId, providers]);

  const createProvider = async (input: { templateId?: string; providerName?: string }) => {
    // React 重新渲染前的连续点击也必须只创建一次，不能以按钮 disabled 代替准入。
    if (creatingRef.current) return;
    creatingRef.current = true;
    const navigationIntent = ++navigationIntentRef.current;
    setCreating(true);
    try {
      const created = await createPersonalProvider({ ...input, locale: toZhOrEnLocale(locale) });
      // 新建结果已由 Hook 提交配置，但不能覆盖等待期间用户更新的导航意图。
      if (navigationIntentRef.current !== navigationIntent) return;
      setPendingCreatedProviderId(created.providerId);
      setSelectedProviderId(created.providerId);
      setTemplatePickerOpen(false);
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };
  const [deleteFailedId, setDeleteFailedId] = useState<string | null>(null);
  const deleteInFlightRef = useRef(false);
  const performDelete = async (id: string) => {
    if (deleteInFlightRef.current) return;
    deleteInFlightRef.current = true;
    setDeleteFailedId(null);
    try {
      await deleteProvider(id);
      setSelectedProviderId((current) => (current === id ? null : current));
    } catch (error) {
      // 删除失败保留当前连接与输入；重试复用已经确认的删除意图，不再弹第二次确认。
      setDeleteFailedId(id);
      throw error;
    } finally {
      deleteInFlightRef.current = false;
    }
  };
  const removeProvider = async (provider: ProviderSettingsFormProvider) => {
    await confirmAndDeleteModelProvider({
      provider,
      confirmDialog,
      intl,
      deleteProvider: performDelete,
    });
  };
  const handleSave = useCallback(
    async (provider: ProviderSettingsFormProvider) => {
      await saveProvider(provider);
    },
    [saveProvider],
  );
  const refreshProviders = async () => {
    setRefreshFailed(false);
    try {
      await refresh();
    } catch {
      setRefreshFailed(true);
    }
  };
  const reorderProviders = async (orderedIds: string[]) => {
    const moved = new Set(orderedIds);
    const allIds = sortModelProvidersForDisplay(modelProviders, displayOrder).map(
      (provider) => provider.providerId,
    );
    const insertion = allIds.findIndex((id) => moved.has(id));
    if (insertion < 0) return;
    const next = allIds.filter((id) => !moved.has(id));
    next.splice(insertion, 0, ...orderedIds);
    await saveDisplayOrder({ providerIds: next });
  };
  const groups: ModelProviderNavGroup[] = [
    {
      id: "custom",
      title: intl.formatMessage({ id: "settings.modelProvider.connectionsTitle" }),
      items: providers.map((provider) => ({
        type: "custom",
        key: createCustomProviderNodeKey(provider.providerId),
        label: getProviderFormLabel(provider),
        provider,
        statusActive: provider.executable,
      })),
    },
  ];
  const apiKeyUrl = selectedProvider?.templateId
    ? getProviderFormApiKeyManagementUrl(selectedProvider)
    : undefined;
  if (loadError)
    return (
      <div
        className="flex min-h-64 flex-col items-center justify-center gap-3 text-ui-base"
        role="alert"
      >
        <p>{intl.formatMessage({ id: "settings.modelProvider.loadFailed" })}</p>
        <Button type="button" variant="outline" onClick={reload}>
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      </div>
    );
  return (
    <ModelProviderSectionLayout
      description={intl.formatMessage({ id: "settings.modelProviderDescription" })}
      refreshLabel={intl.formatMessage({ id: "settings.modelProvider.refresh" })}
      loadingLabel={intl.formatMessage({ id: "common.loading" })}
      presetLoading={false}
      customLoading={loading || refreshing}
      onRefresh={() => void refreshProviders()}
      addProviderLabel={intl.formatMessage({ id: "settings.modelProvider.addProviderAction" })}
      onAddProvider={() => {
        navigationIntentRef.current++;
        setTemplatePickerOpen(true);
      }}
      navigationGroups={groups}
      selectedNodeKey={
        selectedProvider ? createCustomProviderNodeKey(selectedProvider.providerId) : null
      }
      onSelectNavItem={(item) => {
        if (item.type === "custom") {
          navigationIntentRef.current++;
          setSelectedProviderId(item.provider.providerId);
          setTemplatePickerOpen(false);
        }
      }}
      onReorderProviderIds={reorderProviders}
      reorderableProviderIds={reorderableProviderIds}
    >
      {invalidTarget ? (
        <p role="alert" className="mb-3 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.navigationUnavailable" })}
        </p>
      ) : null}
      {deleteFailedId === selectedProvider?.providerId ? (
        <div role="alert" className="mb-3 flex items-center gap-2 text-ui-base">
          <p>{intl.formatMessage({ id: "settings.modelProvider.deleteFailed" })}</p>
          <Button
            type="button"
            variant="ghost"
            onClick={() => void performDelete(deleteFailedId).catch(() => undefined)}
          >
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </div>
      ) : null}
      {refreshFailed ? (
        <div role="alert" className="mb-3 flex items-center gap-2 text-ui-base">
          <p>{intl.formatMessage({ id: "settings.modelProvider.refreshFailed" })}</p>
          <Button type="button" variant="ghost" onClick={() => void refreshProviders()}>
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </div>
      ) : null}
      {loading ? (
        <p role="status" className="text-ui-base">
          {intl.formatMessage({ id: "common.loading" })}
        </p>
      ) : showPicker ? (
        <ProviderTemplatePicker
          templates={providerTemplates}
          creating={creating}
          onBack={
            providers.length
              ? () => {
                  navigationIntentRef.current++;
                  setTemplatePickerOpen(false);
                }
              : undefined
          }
          onCreateFromTemplate={(templateId) => createProvider({ templateId })}
          onCreateCustom={(providerName) => createProvider({ providerName })}
        />
      ) : selectedProvider ? (
        <InlineEditableProviderCard
          key={selectedProvider.providerId}
          provider={selectedProvider}
          // 保存模型草稿按 revision 做乐观并发校验；968a868 重构删掉 Detail.tsx 时
          // 丢了这条传递，导致 basedOnRevision 恒为 0、编辑保存必然冲突。
          settingsRevision={providerSettingsView?.revision}
          onSave={handleSave}
          onAddPersonalModel={addPersonalModel}
          onSavePersonalModelDraft={savePersonalModelDraft}
          onSetPersonalModelEnabled={setPersonalModelEnabled}
          onDeletePersonalModel={deletePersonalModel}
          onDelete={
            selectedProvider.config.group === "standard-personal"
              ? () => removeProvider(selectedProvider)
              : undefined
          }
          onReorderModelIds={(ids) => reorderProviderModels(selectedProvider.providerId, ids)}
          onTestModel={testModelConnectivity}
          onFetchModels={fetchProviderModels}
          presetApiKeyUrl={apiKeyUrl}
          onOpenPresetApiKey={apiKeyUrl ? () => platform.openExternal(apiKeyUrl) : undefined}
          readOnlyEndpoints={false}
          nameEditable
        />
      ) : null}
    </ModelProviderSectionLayout>
  );
}
