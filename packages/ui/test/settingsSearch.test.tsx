import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  matchesSettingsNavigation,
  matchesSettingsNavigationDescription,
  settingsNavigationSearchKeys,
} from "../src/settings-search/settingsNavigationSearch.js";
import {
  isSettingsSearchItemVisible,
  SETTINGS_SEARCH_ITEMS,
  type SettingsSearchAvailability,
} from "../src/settings-search/settingsSearchIndex.js";
import { createSettingsPageConfig } from "../src/settings/settingsPageConfig.js";

const ALL_AVAILABLE: SettingsSearchAvailability = {
  desktop: true,
  macDesktop: true,
  windowsHost: true,
  tray: true,
  notWindows: true,
  workflow: true,
};

const UI_SRC = fileURLToPath(new URL("../src", import.meta.url));

async function readUiSource(relativePath: string): Promise<string> {
  return readFile(join(UI_SRC, relativePath), "utf8");
}

describe("设置搜索匹配规则", () => {
  it("中文标签支持全拼与首字母，大小写/全角/空白归一化", () => {
    const keys = settingsNavigationSearchKeys(["动态工作流"]);
    expect(matchesSettingsNavigation("dongtai", keys)).toBe(true);
    expect(matchesSettingsNavigation("dtgzl", keys)).toBe(true);
    expect(matchesSettingsNavigation("动态工作", keys)).toBe(true);
    expect(matchesSettingsNavigation("静态", keys)).toBe(false);

    const english = settingsNavigationSearchKeys(["Terminal Font"]);
    expect(matchesSettingsNavigation("terminalfont", english)).toBe(true);
    expect(matchesSettingsNavigation("ＴＥＲＭＩＮＡＬ", english)).toBe(true);
    expect(matchesSettingsNavigation("font", english)).toBe(true);
    expect(matchesSettingsNavigation("mono", english)).toBe(false);
  });

  it("顺序字符匹配不要求连续，但顺序错误不命中", () => {
    const keys = settingsNavigationSearchKeys(["Open HTML files in browser"]);
    expect(matchesSettingsNavigation("ohfib", keys)).toBe(true);
    expect(matchesSettingsNavigation("bihfo", keys)).toBe(false);
    expect(matchesSettingsNavigation("", keys)).toBe(true);
  });

  it("说明只做子串匹配，避免长说明的顺序字符产生大量无关结果", () => {
    const descriptionKeys = settingsNavigationSearchKeys(["Single-clicking opens the browser"]);
    expect(matchesSettingsNavigationDescription("opens the browser", descriptionKeys)).toBe(true);
    expect(matchesSettingsNavigationDescription("sbw", descriptionKeys)).toBe(false);
    expect(matchesSettingsNavigationDescription("", descriptionKeys)).toBe(false);
  });
});

describe("设置搜索索引", () => {
  it("每一项的 id/说明 key 在两种语言里都存在，且分区存在", () => {
    const { settingsSections } = createSettingsPageConfig({
      isDesktop: true,
      isMacDesktop: false,
      isWindowsDesktop: false,
    });
    const sectionIds = new Set(settingsSections.map((section) => section.id));
    for (const item of SETTINGS_SEARCH_ITEMS) {
      expect(sectionIds.has(item.section), `${item.id} -> ${item.section}`).toBe(true);
      expect(enUS[item.id], `en-US missing ${item.id}`).toBeTruthy();
      expect(zhCN[item.id], `zh-CN missing ${item.id}`).toBeTruthy();
      expect(enUS[item.description], `en-US missing ${item.description}`).toBeTruthy();
      expect(zhCN[item.description], `zh-CN missing ${item.description}`).toBeTruthy();
    }
  });

  it("每一条索引都真的接到了某个 SettingsRow 的 searchId", async () => {
    const sources = await Promise.all(
      [
        "settingsPageHelpers.tsx",
        "settings/LocaleSelectorRow.tsx",
        "settingsCodePreview.tsx",
        "settings/BrowserSettingsSection.tsx",
        "settings/ComputerUseSection.tsx",
        "settings/MemorySettingsSection.tsx",
        "settings/ProactiveSuggestionsSetting.tsx",
        "settings/DynamicWorkflowModeSetting.tsx",
        "settings/FileTreeHtmlOpenSetting.tsx",
        "settings/PersonalizationSection.tsx",
      ].map(readUiSource),
    );
    const haystack = sources.join("\n");
    for (const item of SETTINGS_SEARCH_ITEMS) {
      expect(haystack.includes(`searchId="${item.id}"`), `unwired searchId ${item.id}`).toBe(true);
    }
  });

  it("不登记本仓已移除的云端/付费/数据同步行", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id).join(",");
    for (const removed of [
      "settings.mobilePush",
      "settings.dataSync",
      "settings.shares",
      "settings.projects",
      "settings.archives",
      "settings.codingPlan",
    ]) {
      expect(ids.includes(removed), removed).toBe(false);
    }
  });

  it("可见性按环境门禁过滤", () => {
    const onlyDesktop: SettingsSearchAvailability = {
      ...ALL_AVAILABLE,
      desktop: false,
      macDesktop: false,
      windowsHost: false,
      tray: false,
      workflow: false,
    };
    expect(isSettingsSearchItemVisible("all", onlyDesktop)).toBe(true);
    expect(isSettingsSearchItemVisible("desktop", onlyDesktop)).toBe(false);
    expect(isSettingsSearchItemVisible("desktop", { ...onlyDesktop, desktop: true })).toBe(true);
    expect(isSettingsSearchItemVisible("workflow", onlyDesktop)).toBe(false);
  });
});
