/* eslint-disable max-lines -- Hooks 页面聚合 Scope、插件投影、搜索与配置写入流程。 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { Hook, HookConfig, ZCodeInstalledPluginSummary, ZCodePluginInfo } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { invalidateDeferredDraftSessionForRuntimeChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { useHooksStore } from "@/store/hooksStore.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { HookForm } from "./HookForm.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { getWorkspaceKey } from "@/lib/workspaceKey.js";
import { HooksList, type HookScope, type PluginHookRow } from "./HooksList.js";
import { useWorkspaceHookInlineTrust } from "./useWorkspaceHookInlineTrust.js";
import { useWorkspaceHookReviewStore } from "@/store/workspaceHookReviewStore.js";
import {
  SettingsScopeBlockedNotice,
  SettingsScopeDeviceProvider,
  SettingsScopePicker,
  resolveSettingsScopeBlock,
  resolveSettingsScopeTargetBlock,
  useSettingsScope,
  useSettingsScopeForm,
} from "@/settings-scope/index.js";
import { PluginLoadingState, PluginSearchEmptyState } from "@/settings/PluginInstallEmptyState.js";
import {
  resolvePluginDisplayName,
  resolveUniquePluginListingByName,
} from "@/settings/pluginStoreListing.js";
import {
  shouldShowWorkspaceHookTrustNotice,
  WorkspaceHookTrustNotice,
} from "@/settings/WorkspaceHookTrustNotice.js";

interface HooksSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
}

function isEditableHook(hook: Hook): boolean {
  // workspace-hook-trust：运行时 discovery 会下发 editable 标志（工作区 Hook 在
  // runtime 侧不可直接改配置），优先尊重；本地 Settings 发现路径无该标志时回退旧规则。
  return hook.editable ?? (!hook.location || hook.location.source === "zcode");
}

// workspace-hook-trust：editable=false 且 source=zcode 的行是「上游/祖先 zcode.json
// 里的只读工作区 Hook」。它们不是外部格式兼容导入源，塞进 Legacy 会让 Import 按钮
// 必然失败（importHook 拒绝 source=zcode），也违反「只读但可逐条 Trust」的约定。
// 这类行应留在 Installed 分组，由信任状态门控 Switch，走行内 Trust 流程。
function isReadOnlyZCodeHook(hook: Hook): boolean {
  return hook.editable === false && (hook.location?.source ?? "zcode") === "zcode";
}

function isInCompatibilitySection(hook: Hook): boolean {
  return !isEditableHook(hook) && !isReadOnlyZCodeHook(hook);
}

/**
 * workspace-hook-trust：解析「最新 review binding」对应的 scope 切换目标。
 * 纯函数（供 HooksSection 与单测共用）：
 * - 按 request.createdAt 取最新 binding（同一 runtime flow 的 generation 递增也会
 *   刷新 createdAt，语义是「最新出现的审核」）；
 * - identity 优先精确匹配 tab 的 scope key；无 identity 的旧本地 binding 才按
 *   workspacePath 回退（与 matchesWorkspaceBinding 的降级规则一致）；
 * - 找不到对应 tab（workspace 已关闭/未知）返回 null——调用方不得切过去。
 */
function resolveLatestReviewScopeTarget(
  bindings: Record<
    string,
    {
      request: { interactionId: string; createdAt: number; workspaceIdentity?: string };
      workspacePath: string;
    }
  >,
  workspaceTabs: readonly { workspacePath: string; workspaceIdentity?: string }[],
): { interactionId: string; scopeKey: string } | null {
  let latest: {
    interactionId: string;
    createdAt: number;
    workspaceIdentity?: string;
    workspacePath: string;
  } | null = null;
  for (const binding of Object.values(bindings)) {
    if (!latest || binding.request.createdAt > latest.createdAt) {
      latest = {
        interactionId: binding.request.interactionId,
        createdAt: binding.request.createdAt,
        workspaceIdentity: binding.request.workspaceIdentity,
        workspacePath: binding.workspacePath,
      };
    }
  }
  if (!latest) return null;
  // key 规则与 getPluginWorkspaceKey 一致（identity 优先，回退 workspacePath），
  // 这里内联而非复用，避免 helper 依赖 WorkspaceTabState 完整类型、便于单测。
  const scopeKeyOf = (tab: { workspacePath: string; workspaceIdentity?: string }) =>
    tab.workspaceIdentity?.trim() || tab.workspacePath;
  const identity = latest.workspaceIdentity?.trim();
  const tab = identity
    ? workspaceTabs.find((candidate) => scopeKeyOf(candidate) === identity)
    : workspaceTabs.find((candidate) => candidate.workspacePath === latest!.workspacePath);
  return tab ? { interactionId: latest.interactionId, scopeKey: scopeKeyOf(tab) } : null;
}

function buildPluginHookRows(
  plugins: readonly Pick<ZCodePluginInfo, "enabled" | "hookDetails" | "id" | "name">[],
  installedPlugins: readonly Pick<ZCodeInstalledPluginSummary, "id" | "scope">[],
  scopeMetadataKnown: boolean,
): PluginHookRow[] {
  const scopeByPluginId = new Map(
    installedPlugins.map((plugin) => [plugin.id, plugin.scope] as const),
  );
  return plugins.flatMap((plugin) =>
    (plugin.hookDetails ?? []).map((detail) => ({
      detail,
      pluginEnabled: plugin.enabled,
      pluginId: plugin.id,
      pluginName: plugin.name,
      // overview 降级时 installedPlugins=[] 表示 scope 未知，不能伪造成 User。
      pluginScope: scopeMetadataKnown ? scopeByPluginId.get(plugin.id) : undefined,
    })),
  );
}

function filterPluginHooksByScope(
  pluginHooks: readonly PluginHookRow[],
  scope: HookScope,
): PluginHookRow[] {
  const expectedScope = scope === "project" ? "workspace" : "user";
  // 未知 scope 在两个 Tab 都保留并由列表标记，避免降级时隐藏真实存在的插件 Hook。
  return pluginHooks.filter(
    (hook) => hook.pluginScope === undefined || hook.pluginScope === expectedScope,
  );
}

export function HooksSection({ workspacePath, workspaceIdentity }: HooksSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const hooksState = useHooksStore();
  const plugins = usePluginManagementStore((state) => state.plugins);
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const marketplaceAvailabilityKnown = usePluginManagementStore(
    (state) => state.marketplaceAvailabilityKnown,
  );
  const pluginsLoading = usePluginManagementStore((state) => state.loading);
  const pluginsError = usePluginManagementStore((state) => state.error);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  // Scope 的唯一 owner（L1 模块）：设备分组、选中项解析、本机/远端「用户」目标都由它给出。
  const settingsScope = useSettingsScope({ workspacePath, workspaceIdentity });
  // 表单归属打开它的设备（`settings-scope/app/useSettingsScopeForm`）：设备切换后在渲染期清掉，
  // 旧设备的 hook 内容不会写给新设备（各设备用户 hook 的 id 都从 hook-zcode-user-0 编号）。
  const hookForm = useSettingsScopeForm<{ hook: Hook | null }>(settingsScope);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const editingHook = hookForm.form?.hook ?? null;
  const isFormMode = hookForm.form !== null;
  const {
    groups: scopeGroups,
    selectedScopeKey,
    setSelectedScopeKey,
    resolution: scopeResolution,
    user: settingsUser,
    device: scopeDevice,
    deviceTargets,
    toLocalScopeKey,
    toPageScopeKey,
  } = settingsScope;
  const selectedWorkspaceTarget =
    scopeResolution.status === "ready" && scopeResolution.kind === "workspace"
      ? scopeResolution.target
      : undefined;
  const userSelected = scopeResolution.status === "ready" && scopeResolution.kind === "user";
  const activeScope: HookScope = selectedWorkspaceTarget ? "project" : "user";
  // disconnected / 外设备目标 fail-closed：离线设备整组不出现在菜单里，残留的选中项也不能
  // 借用当前 Host 的服务去读写，只渲染阻断提示。
  const scopeBlock =
    resolveSettingsScopeBlock(settingsScope, userSelected) ??
    resolveSettingsScopeTargetBlock(selectedWorkspaceTarget);
  // 远端「用户」只经该设备的 source-settings attachment 服务；本机「用户」沿用当前
  // workspace 服务解析（本机 Host），不把远端服务当成本机用户配置写入口。
  const remoteUserScope =
    userSelected && settingsUser.status === "ready" && settingsUser.cacheAuthorityKey
      ? settingsUser
      : null;
  const targetWorkspacePath = remoteUserScope
    ? remoteUserScope.target.workspacePath
    : (selectedWorkspaceTarget?.workspacePath ?? workspacePath);
  const targetWorkspaceIdentity = remoteUserScope
    ? undefined
    : (selectedWorkspaceTarget?.workspaceIdentity ?? workspaceIdentity);
  const targetWorkspaceKey = targetWorkspacePath
    ? getWorkspaceKey(targetWorkspacePath, targetWorkspaceIdentity)
    : null;
  const targetServiceResolution = useWorkspaceServicesResolution(
    targetWorkspacePath,
    remoteUserScope ? undefined : selectedWorkspaceTarget?.remoteSessionId,
    targetWorkspaceIdentity,
    remoteUserScope ? undefined : selectedWorkspaceTarget?.remoteTarget,
  );
  // Scope 切到另一个远程 workspace 后，路径已切换但 hooks/plugin 服务仍来自
  // 当前激活 workspace。这里让服务 host 与 target 身份同源，等待连接时不发送越界 RPC。
  const hooksService =
    remoteUserScope?.unscopedServices.hooksService ?? targetServiceResolution.services.hooksService;
  const pluginManagementService =
    remoteUserScope?.unscopedServices.pluginManagementService ??
    targetServiceResolution.services.pluginManagementService;
  const rpcReady =
    scopeBlock === null && (remoteUserScope !== null || targetServiceResolution.rpcReady);
  const scopeTargets = useMemo(
    () =>
      scopeGroups.flatMap((group) =>
        group.options.flatMap((option) => (option.target ? [option.target] : [])),
      ),
    [scopeGroups],
  );
  const scopeDeviceHasUser = scopeGroups.some(
    (group) =>
      (group.device.kind === "local" ? "local" : group.device.id) ===
        (scopeDevice.kind === "local" ? "local" : scopeDevice.id) &&
      group.options.some((option) => option.kind === "user"),
  );
  const zcodeSessionService = useZCodeSessionService(
    targetWorkspacePath ?? undefined,
    undefined,
    targetWorkspaceIdentity,
  );
  // workspace-hook-trust：信任操作绑定到当前选中的 workspace（多 workspace scope 场景
  // 下 review binding 可能属于其他 workspace，此时切换 scope 菜单到对应 workspace）。
  // hooksService 必须传 target 解析结果：scope 选中远程 workspace 时 context 服务指向
  // 激活 tab 的 host，越界 RPC 会打到错误 host。
  const { trustActionAvailable, trustingHookId, trustHook } = useWorkspaceHookInlineTrust({
    workspacePath: targetWorkspacePath,
    workspaceIdentity: targetWorkspaceIdentity,
    hooksService: rpcReady ? hooksService : undefined,
    rpcReady,
  });
  const reviewBindings = useWorkspaceHookReviewStore((state) => state.bindings);

  const editableHooks = useMemo(
    () =>
      hooksState.hooks.filter(
        (hook) =>
          (isEditableHook(hook) || isReadOnlyZCodeHook(hook)) &&
          (hook.location?.scope ?? "user") === activeScope,
      ),
    [activeScope, hooksState.hooks],
  );
  const compatibilityHooks = useMemo(
    () =>
      hooksState.hooks.filter(
        (hook) =>
          isInCompatibilitySection(hook) && (hook.location?.scope ?? "user") === activeScope,
      ),
    [activeScope, hooksState.hooks],
  );
  const pluginHooks = useMemo(
    () => buildPluginHookRows(plugins, installedPlugins, marketplaceAvailabilityKnown),
    [installedPlugins, marketplaceAvailabilityKnown, plugins],
  );
  const pluginListingById = useMemo(
    () => new Map(availablePlugins.map((plugin) => [plugin.id, plugin.listing])),
    [availablePlugins],
  );
  const scopedPluginHooks = useMemo(
    () =>
      filterPluginHooksByScope(pluginHooks, activeScope).map((hook) => ({
        ...hook,
        pluginIconItem: {
          name: hook.pluginName,
          listing: pluginListingById.get(hook.pluginId),
        },
      })),
    [activeScope, pluginHooks, pluginListingById],
  );
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const filteredEditableHooks = useMemo(
    () => editableHooks.filter((hook) => hookMatchesQuery(hook, normalizedQuery)),
    [editableHooks, normalizedQuery],
  );
  const filteredCompatibilityHooks = useMemo(
    () => compatibilityHooks.filter((hook) => hookMatchesQuery(hook, normalizedQuery)),
    [compatibilityHooks, normalizedQuery],
  );
  const filteredPluginHooks = useMemo(
    () =>
      scopedPluginHooks.filter((hook) =>
        [
          hook.pluginName,
          hook.detail.event,
          hook.detail.type,
          hook.detail.matcher,
          hook.detail.command,
          hook.detail.sourcePath,
        ].some((value) => value?.toLowerCase().includes(normalizedQuery)),
      ),
    [normalizedQuery, scopedPluginHooks],
  );

  useEffect(() => {
    if (!rpcReady) return;
    void hooksState.initialize(
      targetWorkspacePath ?? undefined,
      targetWorkspaceIdentity,
      hooksService,
    );
  }, [hooksService, hooksState.initialize, rpcReady, targetWorkspaceIdentity, targetWorkspacePath]);

  useEffect(() => {
    if (!targetWorkspacePath || !rpcReady) return;
    void initializePlugins({
      workspacePath: targetWorkspacePath,
      workspaceIdentity: targetWorkspaceIdentity,
      pluginService: pluginManagementService,
    });
  }, [
    initializePlugins,
    pluginManagementService,
    rpcReady,
    targetWorkspaceIdentity,
    targetWorkspacePath,
  ]);

  const handleRefresh = useCallback(async () => {
    if (!rpcReady) return;
    await Promise.all([
      hooksState.initialize(
        targetWorkspacePath ?? undefined,
        targetWorkspaceIdentity,
        hooksService,
      ),
      targetWorkspacePath
        ? initializePlugins({
            workspacePath: targetWorkspacePath,
            workspaceIdentity: targetWorkspaceIdentity,
            pluginService: pluginManagementService,
          })
        : Promise.resolve(),
    ]);
  }, [
    hooksService,
    hooksState.initialize,
    initializePlugins,
    pluginManagementService,
    rpcReady,
    targetWorkspaceIdentity,
    targetWorkspacePath,
  ]);

  // workspace-hook-trust（修复）：会话区对 workspace B 发起审核时，把 scope 菜单
  // 自动切到 B 一次。两条硬约束：
  // 1. 只在「新 interaction 出现」时切——B 的 review 仍 pending 期间用户手动切去
  //    A/User 属于主动选择，不得被持续抢回（否则 pending 期间设置页被锁死在 B）。
  // 2. 目标 workspace 必须仍存在于 workspaceTabs——binding 指向已关闭/断连的
  //    workspace 时切过去只会停在 Connecting，还会与上面的「失效 scope 重置 user」
  //    effect 形成乒乓循环。
  const latestReviewScopeTarget = useMemo(
    () => resolveLatestReviewScopeTarget(reviewBindings, scopeTargets),
    [reviewBindings, scopeTargets],
  );
  const handledReviewInteractionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!latestReviewScopeTarget) return;
    if (handledReviewInteractionRef.current === latestReviewScopeTarget.interactionId) return;
    handledReviewInteractionRef.current = latestReviewScopeTarget.interactionId;
    if (latestReviewScopeTarget.scopeKey !== selectedScopeKey) {
      setSelectedScopeKey(latestReviewScopeTarget.scopeKey);
    }
  }, [latestReviewScopeTarget, selectedScopeKey]);

  const invalidateDraft = useCallback(
    async (reason: string) => {
      await invalidateDeferredDraftSessionForRuntimeChange({
        logScope: "hooks",
        reason,
        workspaceIdentity: targetWorkspaceIdentity,
        workspacePath: targetWorkspacePath,
        zcodeSessionService,
      });
    },
    [targetWorkspaceIdentity, targetWorkspacePath, zcodeSessionService],
  );

  const handleSaveHook = useCallback(
    async (config: HookConfig) => {
      try {
        if (editingHook) {
          await hooksState.updateHook(editingHook.id, config, hooksService);
          await invalidateDraft("hook-updated");
        } else {
          await hooksState.addHook(config, hooksService);
          await invalidateDraft("hook-added");
        }
        hookForm.closeForm();
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [
      editingHook,
      hookForm,
      hooksService,
      hooksState.addHook,
      hooksState.updateHook,
      invalidateDraft,
    ],
  );
  const handleCreateHook = useCallback(() => {
    hookForm.openForm({ hook: null });
  }, [hookForm]);

  const handleDelete = useCallback(
    async (hook: Hook) => {
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "settings.hooks.delete" }),
        description: intl.formatMessage(
          { id: "settings.hooks.deleteDescription" },
          { event: hook.event },
        ),
        confirmLabel: intl.formatMessage({ id: "common.delete" }),
      });
      if (!confirmed) return;
      try {
        await hooksState.deleteHook(hook.id, hooksService);
        await invalidateDraft("hook-deleted");
        hookForm.closeForm();
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [confirmDialog, hookForm, hooksService, hooksState.deleteHook, intl, invalidateDraft],
  );

  const handleToggle = useCallback(
    async (hook: Hook, enabled: boolean) => {
      try {
        await hooksState.toggleHook(hook.id, enabled, hooksService);
        await invalidateDraft(enabled ? "hook-enabled" : "hook-disabled");
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [hooksService, hooksState.toggleHook, invalidateDraft],
  );

  const handleImport = useCallback(
    async (hook: Hook) => {
      try {
        await hooksState.importHook(hook.id, hooksService);
        await invalidateDraft("hook-imported");
        toast(intl.formatMessage({ id: "settings.hooks.imported" }));
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [hooksService, hooksState.importHook, intl, invalidateDraft],
  );

  if (isFormMode && rpcReady) {
    return (
      <>
        <SettingsBreadcrumbReporter
          items={[
            {
              label: editingHook?.event ?? intl.formatMessage({ id: "settings.hooks.add" }),
            },
          ]}
          onSectionSelect={() => hookForm.closeForm()}
        />
        {/* 表单内的 Scope 菜单只列当前设备的「用户」与项目：写入目标由分区按同一设备解析。 */}
        <SettingsScopeDeviceProvider device={scopeDevice} userAvailable={scopeDeviceHasUser}>
          <HookForm
            hook={editingHook ?? undefined}
            workspaceAvailable={Boolean(targetWorkspacePath)}
            defaultStorageLevel={activeScope}
            selectedScopeKey={toLocalScopeKey(selectedScopeKey)}
            workspaceTabs={deviceTargets}
            onScopeKeyChange={(localKey) => setSelectedScopeKey(toPageScopeKey(localKey))}
            onSave={handleSaveHook}
            onDelete={editingHook ? handleDelete : undefined}
            onCancel={() => hookForm.closeForm()}
            isEditing={Boolean(editingHook)}
          />
        </SettingsScopeDeviceProvider>
      </>
    );
  }

  const loading = hooksState.loading || pluginsLoading;
  const error = hooksState.error || pluginsError;
  const visibleCount =
    filteredEditableHooks.length + filteredCompatibilityHooks.length + filteredPluginHooks.length;
  const totalCount = editableHooks.length + compatibilityHooks.length + scopedPluginHooks.length;
  const hasSearchResultEmpty = Boolean(normalizedQuery) && visibleCount === 0;
  const showWorkspaceHookTrustNotice = shouldShowWorkspaceHookTrustNotice({
    hooks: editableHooks,
    loadedWorkspaceKey: hooksState.loadedWorkspaceKey,
    rpcReady,
    targetWorkspaceKey,
  });
  return (
    <div className="space-y-6" data-testid="hooks-settings-section">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <SettingsScopePicker
            scope={{
              groups: scopeGroups,
              selectedScopeKey,
              setSelectedScopeKey,
              resolution: scopeResolution,
            }}
            align="start"
            triggerTestId="hooks-settings-scope-trigger"
            userOptionTestId="hooks-settings-scope-user-option"
            workspaceOptionTestIdPrefix="hooks-settings-scope-option"
          />
          <div className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
          <div
            data-independent-capability-count="true"
            className="flex h-7 items-center gap-1 px-3 text-ui-base font-medium text-foreground"
          >
            <span>{intl.formatMessage({ id: "settings.hooks.title" })}</span>
            <span className="text-ui-sm text-foreground-subtle">{visibleCount}</span>
          </div>
        </div>
        <SettingsSearchInput
          containerClassName="w-full sm:ml-auto sm:w-64"
          clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
          value={query}
          onClear={() => setQuery("")}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={intl.formatMessage({
            id: "settings.hooks.searchPlaceholder",
          })}
        />
      </div>

      {showWorkspaceHookTrustNotice ? <WorkspaceHookTrustNotice hooks={editableHooks} /> : null}

      {scopeBlock !== null ? (
        <SettingsScopeBlockedNotice state={scopeBlock} device={scopeDevice} />
      ) : null}

      {rpcReady && error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          {error}
        </div>
      ) : null}

      {scopeBlock !== null ? null : !rpcReady ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.connecting" })} />
      ) : loading && totalCount === 0 ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
      ) : hasSearchResultEmpty ? (
        <PluginSearchEmptyState label={intl.formatMessage({ id: "settings.hooks.searchEmpty" })} />
      ) : (
        <HooksList
          compatibilityHooks={filteredCompatibilityHooks}
          editableHooks={filteredEditableHooks}
          operatingHookId={hooksState.operatingHookId}
          pluginHooks={filteredPluginHooks}
          showInstalledSection={!normalizedQuery}
          installedEmptyTitle={intl.formatMessage({
            id: "settings.plugin.hooks.emptyInstalledTitle",
          })}
          installedEmptyDescription={intl.formatMessage({
            id: "settings.plugin.hooks.emptyInstalledDescription",
          })}
          installedEmptyActions={
            <Button type="button" variant="default" size="lg" onClick={handleCreateHook}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.hooks.add" })}
            </Button>
          }
          installedAction={
            <SettingsResourceHeaderActions
              onRefresh={() => void handleRefresh()}
              onNew={handleCreateHook}
              newActionId="settings.hooks.add"
            />
          }
          formatPluginName={(name, pluginId) =>
            resolvePluginDisplayName(
              {
                name,
                listing:
                  (pluginId ? pluginListingById.get(pluginId) : undefined) ??
                  resolveUniquePluginListingByName(availablePlugins, name),
              },
              locale,
            )
          }
          onEdit={(target) => {
            hookForm.openForm({ hook: target });
          }}
          onImport={handleImport}
          onTrust={trustHook}
          trustActionAvailable={trustActionAvailable}
          trustingHookId={trustingHookId}
          onToggle={handleToggle}
        />
      )}
    </div>
  );
}

function hookMatchesQuery(hook: Hook, normalizedQuery: string): boolean {
  if (!normalizedQuery) {
    return true;
  }
  return [
    hook.event,
    hook.type,
    hook.matcher,
    hook.command,
    ...(hook.args ?? []),
    hook.location?.directoryPath,
  ].some((value) => value?.toLowerCase().includes(normalizedQuery));
}
