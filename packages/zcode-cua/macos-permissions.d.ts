import type { MacOSPermissionStatus } from "@trycua/cua-driver/electron";

export interface LoadMacOSPermissionHostOptions {
  load?: () => Promise<unknown>;
}

export declare function loadMacOSPermissionHost(
  options?: LoadMacOSPermissionHostOptions,
): Promise<typeof import("@trycua/cua-driver/electron") | undefined>;

export declare function requestMacOSPermissionsFromHost(
  options?: LoadMacOSPermissionHostOptions,
): Promise<MacOSPermissionStatus | undefined>;

export declare function hasRequiredMacOSPermissions(
  status: MacOSPermissionStatus | undefined,
): boolean;

export declare function openMacOSScreenRecordingSettingsPanel(
  options?: LoadMacOSPermissionHostOptions,
): Promise<boolean>;
