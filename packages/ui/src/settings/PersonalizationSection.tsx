import { useCallback, useEffect, useMemo } from "react";
import type { ISettingService } from "@zcode/services";
import { USER_INSTRUCTIONS_MAX_BYTES } from "@zcode/shared";
import {
  TID_SETTINGS_PERSONALIZATION_CANCEL,
  TID_SETTINGS_PERSONALIZATION_EDITOR,
  TID_SETTINGS_PERSONALIZATION_SAVE,
  TID_SETTINGS_PERSONALIZATION_SIZE_HINT,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import {
  countUserInstructionBytes,
  formatUserInstructionKb,
  resolvePersonalizationSaveGate,
  usePersonalizationDraftStore,
} from "@/settings/personalizationDraft.js";

type PersonalizationSettingService = Pick<
  ISettingService,
  "getUserInstructions" | "saveUserInstructions"
>;

/**
 * 个性化（用户自定义指令）编辑页，单层直达：说明 → 直接铺在页面上的编辑器。
 *
 * 唯一事实源是 `{HOME}/.zcodium/AGENTS.md`（本仓 CLI 读取的用户级默认指令）。
 * 仅桌面本地入口渲染编辑器（Web/手机给本地端指引，不发起任何读写，避免把 A 机器的
 * 草稿写到 B 机器）。显式保存/取消；Ctrl/Cmd+S 等价保存。
 * spec：`.agents/specs/upstream-3.18-ui-settings-files.md` §1。
 */
export function PersonalizationSection({
  settingService,
  isDesktop = false,
}: {
  settingService?: PersonalizationSettingService;
  /** 仅桌面本地入口可编辑：手机远控的 base services 可能归属远程 Source。 */
  isDesktop?: boolean;
}) {
  if (!isDesktop || !settingService) {
    return <LocalOnlyPersonalizationHint />;
  }
  return <DesktopPersonalizationEditor settingService={settingService} />;
}

function LocalOnlyPersonalizationHint() {
  const { intl } = useZCodeIntl();
  return (
    <p className="text-ui-base leading-6 text-foreground-subtle">
      {intl.formatMessage({ id: "settings.personalization.localOnly" })}
    </p>
  );
}

function DesktopPersonalizationEditor({
  settingService,
}: {
  settingService: PersonalizationSettingService;
}) {
  const { intl } = useZCodeIntl();
  const readState = usePersonalizationDraftStore((state) => state.readState);
  const baseline = usePersonalizationDraftStore((state) => state.baseline);
  const draft = usePersonalizationDraftStore((state) => state.draft);
  const truncated = usePersonalizationDraftStore((state) => state.truncated);
  const saving = usePersonalizationDraftStore((state) => state.saving);
  const beginLoad = usePersonalizationDraftStore((state) => state.beginLoad);
  const markLoadSuccess = usePersonalizationDraftStore((state) => state.markLoadSuccess);
  const markLoadError = usePersonalizationDraftStore((state) => state.markLoadError);
  const setDraft = usePersonalizationDraftStore((state) => state.setDraft);
  const beginSave = usePersonalizationDraftStore((state) => state.beginSave);
  const endSaveSuccess = usePersonalizationDraftStore((state) => state.endSaveSuccess);
  const endSaveFailure = usePersonalizationDraftStore((state) => state.endSaveFailure);

  const load = useCallback(async () => {
    const { generation, requestId } = beginLoad(settingService);
    try {
      const result = await settingService.getUserInstructions();
      markLoadSuccess(result, generation, requestId);
    } catch (error) {
      // 读取失败不能当空文件：基线缺失时禁用编辑并提供重试，否则用户输入无法安全保存。
      logger.warn("[PersonalizationSection] 读取个性化指令失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      markLoadError(generation, requestId);
    }
  }, [beginLoad, markLoadError, markLoadSuccess, settingService]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveGate = useMemo(
    () => resolvePersonalizationSaveGate({ readState, baseline, draft, truncated, saving }),
    [baseline, draft, readState, truncated, saving],
  );

  const handleSave = useCallback(async () => {
    const generation = usePersonalizationDraftStore.getState().generation;
    beginSave(generation);
    try {
      await settingService.saveUserInstructions(draft);
      endSaveSuccess(draft, generation);
      toast(intl.formatMessage({ id: "settings.personalization.saved" }));
    } catch (error) {
      // 失败时草稿保留在模块级 store：即使保存中切走分区（组件已卸载），重进仍可重试。
      endSaveFailure(generation);
      logger.warn("[PersonalizationSection] 保存个性化指令失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.personalization.saveFailed" }));
    }
  }, [beginSave, draft, endSaveFailure, endSaveSuccess, intl, settingService]);

  const draftBytes = useMemo(() => countUserInstructionBytes(draft), [draft]);

  return (
    // 编辑器直接铺在页面背景上（同参照界面）；指令是自然语言，不用等宽字体。
    <div className="space-y-4">
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.personalization.description" })}
      </p>
      {readState === "error" ? (
        <div className="space-y-2">
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.personalization.loadFailed" })}
          </p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </div>
      ) : null}
      {/* 读取成功前禁用：没有基线就无法判定脏态，保存门控也不应放行。 */}
      <SettingsFormTextarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            if (saveGate.canSave) {
              void handleSave();
            }
          }
        }}
        spellCheck={false}
        disabled={readState !== "ready" || saving}
        className="min-h-64 w-full text-ui-base"
        placeholder={intl.formatMessage({ id: "settings.personalization.placeholder" })}
        aria-label={intl.formatMessage({ id: "settings.personalization.editorLabel" })}
        data-testid={TID_SETTINGS_PERSONALIZATION_EDITOR}
      />
      <div className="flex items-start justify-between gap-3">
        {saveGate.overLimit ? (
          <p
            className="text-ui-base text-destructive"
            data-testid={TID_SETTINGS_PERSONALIZATION_SIZE_HINT}
          >
            {intl.formatMessage({ id: "settings.personalization.sizeOverLimit" })}
          </p>
        ) : (
          <span />
        )}
        <span
          className={`shrink-0 text-ui-sm ${
            saveGate.overLimit ? "text-destructive" : "text-foreground-subtlest"
          }`}
        >
          {intl.formatMessage(
            { id: "settings.personalization.sizeCount" },
            {
              used: formatUserInstructionKb(draftBytes),
              limit: formatUserInstructionKb(USER_INSTRUCTIONS_MAX_BYTES),
            },
          )}
        </span>
      </div>
      <SettingsFormActions>
        <Button
          size="lg"
          disabled={!saveGate.canSave}
          onClick={() => void handleSave()}
          data-testid={TID_SETTINGS_PERSONALIZATION_SAVE}
        >
          {intl.formatMessage({ id: "common.save" })}
        </Button>
        <Button
          variant="ghost"
          size="lg"
          disabled={!saveGate.dirty || saving}
          onClick={() => setDraft(baseline)}
          data-testid={TID_SETTINGS_PERSONALIZATION_CANCEL}
        >
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
        {saveGate.dirty && !saveGate.overLimit ? (
          <span className="self-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.personalization.unsaved" })}
          </span>
        ) : null}
      </SettingsFormActions>
    </div>
  );
}
