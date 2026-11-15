import type { Locale } from "@zcode/shared";
import zhCN from "./locales/zh-CN.js";
import enUS from "./locales/en-US.js";
import jaJP from "./locales/ja-JP.js";
import ruRU from "./locales/ru-RU.js";
import koKR from "./locales/ko-KR.js";

/** English is the fallback for partial official locale overlays. */
export const LOCALE_MESSAGES: Record<Locale, Record<string, string>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
  "ja-JP": { ...enUS, ...jaJP },
  "ru-RU": { ...enUS, ...ruRU },
  "ko-KR": { ...enUS, ...koKR },
};
