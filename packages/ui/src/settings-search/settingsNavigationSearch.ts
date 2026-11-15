import { pinyin } from "pinyin-pro";

/**
 * 设置页导航搜索的匹配规则（纯函数，无 UI/无 IO）。
 *
 * - NFKC + 小写 + 去空白：全角/半角与大小写差异不影响命中。
 * - 中文标签额外生成「全拼」与「拼音首字母」两把 key。
 * - 查询按字符顺序包含匹配（`zdsz` 这类首字母连写也能命中）。
 */
function normalizeSearchText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, "");
}

export function settingsNavigationSearchKeys(labels: readonly string[]): readonly string[] {
  return labels.flatMap((label) => {
    const keys = [normalizeSearchText(label)];
    if (/\p{Script=Han}/u.test(label)) {
      const syllables = pinyin(label, { toneType: "none", type: "array" });
      keys.push(
        normalizeSearchText(syllables.join("")),
        normalizeSearchText(syllables.map((part) => part[0] ?? "").join("")),
      );
    }
    return keys;
  });
}

export function matchesSettingsNavigation(query: string, keys: readonly string[]): boolean {
  const keyword = normalizeSearchText(query);
  if (!keyword) return true;
  return keys.some((key) => {
    let offset = 0;
    for (const character of keyword) {
      const index = key.indexOf(character, offset);
      if (index < 0) return false;
      offset = index + character.length;
    }
    return true;
  });
}

/** 说明文字只做子串匹配：长说明用顺序字符匹配会产生大量无关结果。 */
export function matchesSettingsNavigationDescription(
  query: string,
  descriptionKeys: readonly string[],
): boolean {
  const keyword = normalizeSearchText(query);
  if (!keyword) return false;
  return descriptionKeys.some((key) => normalizeSearchText(key).includes(keyword));
}
