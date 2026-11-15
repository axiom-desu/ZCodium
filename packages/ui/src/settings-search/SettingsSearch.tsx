import { Search, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import enUS from "@/i18n/locales/en-US.js";
import { resolveDynamicWorkflowModeSettingView } from "@/settings/DynamicWorkflowModeSetting.js";
import type { createSettingsPageConfig } from "@/settings/settingsPageConfig.js";
import {
  TID_SETTINGS_SEARCH_CLEAR,
  TID_SETTINGS_SEARCH_DIALOG,
  TID_SETTINGS_SEARCH_EMPTY,
  TID_SETTINGS_SEARCH_INPUT,
  TID_SETTINGS_SEARCH_OPEN,
} from "@zcode/shared";
import type { SettingsSearchResult } from "@/settings-search/contract.js";
import {
  matchesSettingsNavigation,
  matchesSettingsNavigationDescription,
  settingsNavigationSearchKeys,
} from "@/settings-search/settingsNavigationSearch.js";
import {
  isSettingsSearchItemVisible,
  SETTINGS_SEARCH_ITEMS,
  type SettingsSearchAvailability,
} from "@/settings-search/settingsSearchIndex.js";

type SettingsSearchSection = ReturnType<
  typeof createSettingsPageConfig
>["settingsSections"][number];

/**
 * 设置页搜索入口 + 结果对话框。
 *
 * 只持查询草稿；选中后把 `{ section, setting }` 交给 `SettingsPage` 的原导航，
 * 由目标分区里的 `SettingsRow` 自己滚动/聚焦。不预挂载未选分区、不写设置值。
 * spec：`.agents/specs/upstream-3.18-ui-settings-files.md` §2。
 */
export function SettingsSearch({
  sections,
  availability,
  onSelect,
}: {
  sections: readonly SettingsSearchSection[];
  availability: Omit<SettingsSearchAvailability, "workflow">;
  onSelect: (result: SettingsSearchResult) => void;
}) {
  const { intl } = useZCodeIntl();
  const resolvedAvailability: SettingsSearchAvailability = {
    ...availability,
    workflow: resolveDynamicWorkflowModeSettingView(useDynamicWorkflowAvailability()) !== null,
  };
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedRef = useRef<SettingsSearchResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const title = intl.formatMessage({ id: "settings.search.title" });

  const entries = useMemo(
    () =>
      sections.flatMap((section) => {
        const sectionLabel = intl.formatMessage({ id: section.titleId });
        const items = SETTINGS_SEARCH_ITEMS.filter((item) => item.section === section.id).map(
          (item) => ({
            section: section.id,
            setting: item.id,
            label: intl.formatMessage({ id: item.id }),
            sectionLabel,
            keys: settingsNavigationSearchKeys([
              intl.formatMessage({ id: item.id }),
              enUS[item.id] ?? "",
            ]),
            descriptionKeys: settingsNavigationSearchKeys([
              intl.formatMessage({ id: item.description }),
              enUS[item.description] ?? "",
            ]),
            visibility: item.visibility,
          }),
        );
        return [
          {
            section: section.id,
            setting: undefined,
            label: sectionLabel,
            sectionLabel,
            keys: settingsNavigationSearchKeys([sectionLabel, enUS[section.titleId] ?? ""]),
            descriptionKeys: [] as readonly string[],
            visibility: "all" as const,
          },
          ...items,
        ];
      }),
    [intl, sections],
  );

  const results = entries
    .flatMap((entry) => {
      if (!isSettingsSearchItemVisible(entry.visibility, resolvedAvailability)) return [];
      const nameMatch = matchesSettingsNavigation(query, entry.keys);
      const descriptionMatch =
        !nameMatch && matchesSettingsNavigationDescription(query, entry.descriptionKeys);
      return nameMatch || descriptionMatch ? [{ ...entry, rank: nameMatch ? 0 : 1 }] : [];
    })
    // Array.prototype.sort 是稳定排序：同 rank 内保留分区/索引进制顺序。
    .sort((left, right) => left.rank - right.rank);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery("");
          selectedRef.current = null;
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={title}
          data-testid={TID_SETTINGS_SEARCH_OPEN}
          className="w-full justify-start gap-2 text-foreground-subtle max-lg:size-9 max-lg:justify-center max-lg:px-0"
        >
          <Search className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate max-lg:sr-only">{title}</span>
        </Button>
      </DialogTrigger>
      <DialogContent
        data-testid={TID_SETTINGS_SEARCH_DIALOG}
        showCloseButton={false}
        className="top-[15%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
        onCloseAutoFocus={(event) => {
          const selected = selectedRef.current;
          if (selected) {
            // 先结束 Dialog 的焦点锁，再导航，让目标设置行拥有最后一次聚焦权。
            if (selected.setting) event.preventDefault();
            selectedRef.current = null;
            onSelect(selected);
          }
        }}
        onEscapeKeyDown={(event) => {
          // 输入法组字中 Escape 是候选操作，不能顺带清空查询或关闭对话框。
          if (event.isComposing || event.keyCode === 229) {
            event.preventDefault();
            return;
          }
          if (query) {
            event.preventDefault();
            setQuery("");
          }
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.search.description" })}
          </DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false} label={title} className="rounded-xl p-2">
          <div className="relative">
            <CommandInput
              ref={inputRef}
              value={query}
              onValueChange={setQuery}
              aria-label={title}
              placeholder={title}
              data-testid={TID_SETTINGS_SEARCH_INPUT}
              className="pr-9 compact-web:text-mobile-input-safe"
            />
            {query ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={intl.formatMessage({ id: "settings.search.clear" })}
                data-testid={TID_SETTINGS_SEARCH_CLEAR}
                className="absolute right-2 top-1.5"
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
              >
                <X className="size-4" />
              </Button>
            ) : null}
          </div>
          <CommandList
            className="max-h-[55vh]"
            aria-label={intl.formatMessage({ id: "settings.search.results" })}
          >
            {results.length === 0 ? (
              <p
                role="status"
                data-testid={TID_SETTINGS_SEARCH_EMPTY}
                className="px-4 py-8 text-center text-ui-base text-foreground-subtle"
              >
                {intl.formatMessage({ id: "settings.search.empty" })}
              </p>
            ) : (
              results.map((entry) => (
                <CommandItem
                  key={entry.setting ?? entry.section}
                  value={entry.setting ?? entry.section}
                  data-settings-search-result={entry.setting ?? entry.section}
                  className="items-start rounded-md py-2"
                  onSelect={() => {
                    selectedRef.current = { section: entry.section, setting: entry.setting };
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-ui-base">{entry.label}</span>
                    <span className="block text-ui-sm text-foreground-subtle">
                      {entry.setting
                        ? entry.sectionLabel
                        : intl.formatMessage({ id: "settings.search.section" })}
                    </span>
                  </span>
                </CommandItem>
              ))
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
