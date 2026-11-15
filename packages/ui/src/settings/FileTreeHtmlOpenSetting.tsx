import { useState } from "react";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 「单击 HTML 文件时在内置浏览器中打开」。
 *
 * 这是本机用户的界面偏好：调用方必须把本组件放在 base Host 的 ServiceProvider 里
 * （`useBaseWorkspaceServices()`），远端 workspace 激活时也读写本机设置；
 * 文件树（`WorkspaceFileTree`）读同一份设置。
 * spec：`.agents/specs/upstream-3.18-ui-settings-files.md` §4。
 */
export function FileTreeHtmlOpenSetting() {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const [saving, setSaving] = useState(false);
  const label = intl.formatMessage({ id: "settings.browser.htmlClickOpensBrowser" });

  const handleChange = async (enabled: boolean) => {
    setSaving(true);
    try {
      await update({ fileTreeHtmlClickOpensBrowser: enabled });
    } catch (error) {
      logger.warn("[settings] 更新 HTML 文件打开方式失败", { error: String(error) });
      toast(intl.formatMessage({ id: "settings.browser.htmlClickOpensBrowserSaveError" }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsRow
      searchId="settings.browser.htmlClickOpensBrowser"
      label={label}
      description={intl.formatMessage({
        id: "settings.browser.htmlClickOpensBrowserDescription",
      })}
      control={
        <Switch
          aria-label={label}
          checked={settings?.fileTreeHtmlClickOpensBrowser === true}
          disabled={saving || !settings}
          onCheckedChange={(checked) => void handleChange(checked)}
        />
      }
    />
  );
}
