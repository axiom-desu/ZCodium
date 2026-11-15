import { resolveHelpAppConfig, toZhOrEnLocale, type Locale } from "@zcode/shared";
import localDefaultAppConfig from "../../../config/default.json" with { type: "json" };

export async function resolveWebHelpConfig() {
  return resolveHelpAppConfig(localDefaultAppConfig);
}

export async function resolveWebCommunityUrl(locale: Locale): Promise<string | undefined> {
  return (await resolveWebHelpConfig()).community_urls?.[toZhOrEnLocale(locale)];
}
