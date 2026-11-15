import { describe, expect, it } from "vitest";
import {
  LOCALE_NATIVE_NAMES,
  SUPPORTED_LOCALES,
  appSettingsSchema,
  resolveLocaleFromLanguageTag,
  toPersistedSettingsLocaleFields,
} from "@zcode/shared";
import { LOCALE_MESSAGES } from "../src/i18n/localeMessages.js";

describe("additional UI locales", () => {
  it("resolves system language tags and exposes native selector labels", () => {
    expect(resolveLocaleFromLanguageTag("ja-JP")).toBe("ja-JP");
    expect(resolveLocaleFromLanguageTag("ko_KR")).toBe("ko-KR");
    expect(resolveLocaleFromLanguageTag("ru")).toBe("ru-RU");
    expect(SUPPORTED_LOCALES.map((locale) => LOCALE_NATIVE_NAMES[locale])).toEqual([
      "中文简体",
      "English",
      "日本語",
      "Русский",
      "한국어",
    ]);
  });

  it("uses official partial translations and English fallback for newer keys", () => {
    expect(LOCALE_MESSAGES["ja-JP"]["settings.locale"]).toBeTruthy();
    expect(LOCALE_MESSAGES["ko-KR"]["settings.locale"]).toBeTruthy();
    expect(LOCALE_MESSAGES["ru-RU"]["settings.locale"]).toBeTruthy();
    expect(LOCALE_MESSAGES["ja-JP"]["dataSync.title"]).toBe(
      LOCALE_MESSAGES["en-US"]["dataSync.title"],
    );
  });

  it("preserves real UI locale while writing downgrade-compatible settings fields", () => {
    const fields = toPersistedSettingsLocaleFields({ locale: "ru-RU", localePreference: "ru-RU" });
    expect(fields).toEqual({
      locale: "en-US",
      localePreference: "en-US",
      uiLocale: "ru-RU",
      uiLocalePreference: "ru-RU",
    });
    const parsed = appSettingsSchema.parse(fields);
    expect(parsed.locale).toBe("ru-RU");
    expect(parsed.localePreference).toBe("ru-RU");
  });
});
