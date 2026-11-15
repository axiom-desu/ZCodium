import type { AppSettings } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface UserInstructionsSnapshot {
  content: string;
  /** 实际读取/写入的文件路径；UI 只用于展示，不在业务代码里拼路径。 */
  filePath: string;
  /**
   * 文件超过 `USER_INSTRUCTIONS_MAX_BYTES`，content 只是前 100KiB。
   * UI 必须显示可见提示并禁止保存，不能把截断内容当完整基线写回。
   */
  truncated?: boolean;
}

export interface ISettingService {
  get(): Promise<AppSettings>;
  update(
    patch: Partial<AppSettings>,
    expectedAccountSettings?: Pick<
      AppSettings,
      "providerFamilyDomain" | "providerFamilyConnectionSelections"
    >,
  ): Promise<void>;
  /** Change the data base directory: copy data from old → new location, then persist the setting. */
  updateDataBaseDir(newDir: string | undefined): Promise<void>;
  ensureDefaultProject(homedir: string): Promise<{ path: string; created: boolean }>;
  /**
   * 读取用户个性化指令（`{HOME}/.zcodium/AGENTS.md`）。
   * 文件不存在等价于「未配置」，返回空串而不是报错。
   */
  getUserInstructions(): Promise<UserInstructionsSnapshot>;
  /**
   * 保存用户个性化指令。超过 `USER_INSTRUCTIONS_MAX_BYTES` 抛
   * `USER_INSTRUCTIONS_TOO_LARGE_ERROR_CODE`；写入走原子替换并固定 0600。
   */
  saveUserInstructions(content: string): Promise<{ filePath: string }>;
}

export const ISettingService = createServiceDescriptor<ISettingService>(ServiceChannels.Setting);
