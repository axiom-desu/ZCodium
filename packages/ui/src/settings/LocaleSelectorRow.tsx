import {
  LOCALE_NATIVE_NAMES,
  SUPPORTED_LOCALES,
  TID_SETTINGS_LOCALE_SELECT_ITEM,
  TID_SETTINGS_LOCALE_SELECT_TRIGGER,
  testId,
  type LocalePreference,
} from "@zcode/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 语言选择行（唯一实现）：选项是「跟随系统」+ 全部受支持 locale，标签用各自本名。
 *
 * 持久化只走 `ZCodeIntlProvider.setLocalePreference`（localStorage + settingService.update +
 * 跨窗口广播），这里不另存状态，也不把界面语言和 system tag 解析分成两套。
 */
export function LocaleSelectorRow({
  localePreference,
  onLocalePreferenceChange,
}: {
  localePreference: LocalePreference;
  /** 由 `ZCodeIntlProvider` 提供的唯一写入入口（localStorage + settingService + 广播）。 */
  onLocalePreferenceChange: (preference: LocalePreference) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <SettingsGroupCard>
      <SettingsRow
        searchId="settings.locale"
        label={intl.formatMessage({ id: "settings.locale" })}
        description={intl.formatMessage({ id: "settings.localeDescription" })}
        control={
          <Select
            value={localePreference}
            onValueChange={(value) => onLocalePreferenceChange(value as LocalePreference)}
          >
            <SelectTrigger
              size="lg"
              className="w-[260px] min-w-0 justify-between"
              data-testid={TID_SETTINGS_LOCALE_SELECT_TRIGGER}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                value="system"
                data-testid={testId(TID_SETTINGS_LOCALE_SELECT_ITEM, "system")}
              >
                {intl.formatMessage({ id: "settings.locale.system" })}
              </SelectItem>
              {SUPPORTED_LOCALES.map((locale) => (
                <SelectItem
                  key={locale}
                  value={locale}
                  data-testid={testId(TID_SETTINGS_LOCALE_SELECT_ITEM, locale)}
                >
                  {LOCALE_NATIVE_NAMES[locale]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
    </SettingsGroupCard>
  );
}
