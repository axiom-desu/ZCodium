export type {
  SettingsScopeContext,
  SettingsScopeDevice,
  SettingsScopeDeviceState,
  SettingsScopeGroup,
  SettingsScopeOption,
  SettingsScopeResolution,
  SettingsScopeState,
  SettingsUserScope,
} from "@/settings-scope/contract.js";
export {
  LOCAL_USER_SCOPE_KEY,
  buildSettingsScopeGroups,
  getPluginWorkspaceKey,
  isPluginScopeWorkspaceConnected,
  isUserScopeKey,
  parseRemoteUserScopeKey,
  remoteUserScopeKey,
  resolveDefaultSettingsScopeKey,
  resolveSettingsScope,
  resolveSettingsScopeFormDeviceKey,
} from "@/settings-scope/domain/scope.js";
export { useSettingsScope } from "@/settings-scope/app/useSettingsScope.js";
export {
  useSettingsScopeForm,
  type SettingsScopeForm,
} from "@/settings-scope/app/useSettingsScopeForm.js";
export {
  SettingsScopeDeviceProvider,
  useSettingsScopeDevice,
} from "@/settings-scope/ui/SettingsScopeDevice.js";
export { SettingsScopePicker } from "@/settings-scope/ui/SettingsScopePicker.js";
export {
  SettingsScopeBlockedNotice,
  resolveSettingsScopeBlock,
  resolveSettingsScopeTargetBlock,
  type SettingsScopeBlock,
} from "@/settings-scope/ui/SettingsScopeBlockedNotice.js";
