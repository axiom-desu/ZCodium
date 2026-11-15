import { SUPPORTED_LOCALES, type Locale, type LocalePreference } from "./protocol.js";

/** 本名不随界面语言变化，供语言选择控件显示。 */
export const LOCALE_NATIVE_NAMES: Record<Locale, string> = {
  "zh-CN": "中文简体",
  "en-US": "English",
  "ja-JP": "日本語",
  "ru-RU": "Русский",
  "ko-KR": "한국어",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === "system" || isLocale(value);
}

/** 将系统或浏览器语言统一解析为受支持的 UI locale。 */
export function resolveLocaleFromLanguageTag(tag: string | null | undefined): Locale {
  const primary = tag?.trim().toLowerCase().replaceAll("_", "-").split("-")[0] ?? "";
  switch (primary) {
    case "zh":
      return "zh-CN";
    case "ja":
      return "ja-JP";
    case "ru":
      return "ru-RU";
    case "ko":
      return "ko-KR";
    default:
      return "en-US";
  }
}

/** 只有中英内容的契约使用此降级；请求语言 header 必须保留真实 Locale。 */
export function toZhOrEnLocale(locale: Locale | null | undefined): "zh-CN" | "en-US" {
  return locale === "zh-CN" ? "zh-CN" : "en-US";
}

type LegacyPersistedLocale = "zh-CN" | "en-US";
type LegacyPersistedLocalePreference = "system" | LegacyPersistedLocale;

interface PersistedSettingsLocaleFields {
  locale: LegacyPersistedLocale;
  localePreference: LegacyPersistedLocalePreference;
  uiLocale: Locale;
  uiLocalePreference: LocalePreference;
}

export function toLegacyPersistedLocalePreference(
  preference: LocalePreference,
): LegacyPersistedLocalePreference {
  return preference === "system" ? "system" : toZhOrEnLocale(preference);
}

/** setting.json 同时写旧版本可识别字段和新版本真实 locale 字段，避免降级丢失整份设置。 */
export function toPersistedSettingsLocaleFields(settings: {
  locale: Locale;
  localePreference?: LocalePreference;
}): Pick<PersistedSettingsLocaleFields, "locale" | "uiLocale"> &
  Partial<Pick<PersistedSettingsLocaleFields, "localePreference" | "uiLocalePreference">> {
  return {
    locale: toZhOrEnLocale(settings.locale),
    uiLocale: settings.locale,
    ...(settings.localePreference === undefined
      ? {}
      : {
          localePreference: toLegacyPersistedLocalePreference(settings.localePreference),
          uiLocalePreference: settings.localePreference,
        }),
  };
}

export function resolvePersistedUiLocale(raw: Record<string, unknown>): unknown {
  const { uiLocale, locale } = raw;
  return isLocale(uiLocale) && (locale === undefined || toZhOrEnLocale(uiLocale) === locale)
    ? uiLocale
    : locale;
}

export function resolvePersistedUiLocalePreference(raw: Record<string, unknown>): unknown {
  const { uiLocalePreference, localePreference } = raw;
  return isLocalePreference(uiLocalePreference) &&
    (localePreference === undefined ||
      toLegacyPersistedLocalePreference(uiLocalePreference) === localePreference)
    ? uiLocalePreference
    : localePreference;
}

export function hasLegacyIncompatiblePersistedLocale(raw: Record<string, unknown>): boolean {
  const { locale, localePreference } = raw;
  return (
    (locale !== undefined && locale !== "zh-CN" && locale !== "en-US") ||
    (localePreference !== undefined &&
      localePreference !== "system" &&
      localePreference !== "zh-CN" &&
      localePreference !== "en-US")
  );
}
