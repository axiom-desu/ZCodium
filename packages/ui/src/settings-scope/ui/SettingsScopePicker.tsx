import { ChevronDown, Cloud, Folder, Monitor, MonitorSmartphone } from "lucide-react";
import { testId } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { SettingsScopeDevice, SettingsScopeState } from "@/settings-scope/contract.js";
import { LOCAL_USER_SCOPE_KEY } from "@/settings-scope/domain/scope.js";

function deviceLabel(device: SettingsScopeDevice): string | null {
  return device.kind === "local" ? null : device.name;
}

/**
 * 设置页 Scope 菜单：按设备分组的唯一设备选择器（`docs/remote/data-sync.md`「Scope 菜单按设备分组」）。
 *
 * 只消费 `useSettingsScope`（单一 owner）给出的 `groups` / `selectedScopeKey` / `setSelectedScopeKey`：
 * 本机一组在前，其后每台在线设备一组；离线设备整组不出现（`buildSettingsScopeGroups` 已过滤），
 * 因此这里不会给出「选中了却读不到服务」的目标。表单内部只列当前设备的菜单仍用 `PluginScopeMenu`。
 */
export function SettingsScopePicker({
  scope,
  align = "start",
  disabled = false,
  triggerTestId,
  userOptionTestId,
  workspaceOptionTestIdPrefix,
}: {
  scope: Pick<
    SettingsScopeState,
    "groups" | "selectedScopeKey" | "setSelectedScopeKey" | "resolution"
  >;
  align?: "start" | "center" | "end";
  disabled?: boolean;
  triggerTestId?: string;
  userOptionTestId?: string;
  workspaceOptionTestIdPrefix?: string;
}) {
  const { intl } = useZCodeIntl();
  const { groups, selectedScopeKey, setSelectedScopeKey, resolution } = scope;
  const selectedOption = groups
    .flatMap((group) => group.options.map((option) => ({ group, option })))
    .find((entry) => entry.option.key === selectedScopeKey);
  const triggerLabel =
    selectedOption?.option.target?.label ??
    (selectedOption?.option.kind === "user"
      ? intl.formatMessage({ id: "settings.scope.user" })
      : selectedScopeKey);
  const TriggerIcon =
    resolution.status === "offline"
      ? MonitorSmartphone
      : selectedOption?.option.target
        ? selectedOption.group.device.kind === "local"
          ? Folder
          : Cloud
        : Monitor;
  const userAvailable = (group: { options: readonly { kind: "user" | "workspace" }[] }) =>
    group.options.some((option) => option.kind === "user");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="outline"
          size="default"
          data-testid={triggerTestId}
          data-plugin-scope-trigger="true"
          data-plugin-scope-key={selectedScopeKey}
          data-scope-resolution={resolution.status}
          className="rounded-full"
        >
          <TriggerIcon className="size-4" aria-hidden="true" />
          <span className="max-w-48 truncate">{triggerLabel}</span>
          <ChevronDown className="size-4 text-foreground-subtlest" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-72 max-w-[calc(100vw-2rem)]">
        <DropdownMenuRadioGroup
          value={selectedScopeKey}
          onValueChange={(next) => setSelectedScopeKey(next)}
        >
          {groups.map((group, index) => {
            const name = deviceLabel(group.device);
            return (
              <div key={group.device.kind === "local" ? "local" : group.device.id}>
                {index > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuLabel
                  data-scope-device={group.device.kind === "local" ? "local" : group.device.id}
                >
                  {name ?? intl.formatMessage({ id: "settings.scope.localDevice" })}
                </DropdownMenuLabel>
                {group.options.map((option) => {
                  const isUser = option.kind === "user";
                  const OptionIcon = isUser
                    ? Monitor
                    : group.device.kind === "local"
                      ? Folder
                      : Cloud;
                  return (
                    <DropdownMenuRadioItem
                      key={option.key}
                      value={option.key}
                      data-testid={
                        isUser
                          ? userOptionTestId
                          : workspaceOptionTestIdPrefix
                            ? testId(workspaceOptionTestIdPrefix, option.key)
                            : undefined
                      }
                      data-scope-kind={option.kind}
                      className="items-start py-2"
                    >
                      <OptionIcon className="mt-0.5 size-4" aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block truncate text-ui-base font-medium text-foreground">
                          {isUser
                            ? intl.formatMessage({
                                id:
                                  option.key === LOCAL_USER_SCOPE_KEY
                                    ? "settings.plugin.scope.user"
                                    : "settings.scope.deviceUser",
                              })
                            : (option.target?.label ?? option.key)}
                        </span>
                        {isUser ? null : (
                          <span className="block truncate text-ui-sm text-foreground-subtle">
                            {option.target?.workspacePath ?? ""}
                          </span>
                        )}
                      </span>
                    </DropdownMenuRadioItem>
                  );
                })}
                {userAvailable(group) ? null : (
                  <div className="px-2 py-1 text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({ id: "settings.scope.deviceUserUnavailable" })}
                  </div>
                )}
              </div>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
