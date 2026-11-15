import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import type { DataSyncListItem, SkillDataSyncPayload } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { checkRemoteSyncDirectoriesWriteAccess } from "#src/remote-sync/remoteSyncWriteAccess.js";
import { createSkillSyncArchive } from "#src/skill-sync/skillSyncArchive.js";
import { createSkillSyncSizeLimitError } from "#src/skill-sync/skillSyncErrors.js";
import { getUserZcodeSkillRoot, resolveUserHomeDir } from "#src/skill-sync/skillSyncService.js";
import type { IDataSyncCategoryService } from "./contract.js";
import { hashDirectoryContent, isPathWithin, scanDirectoryContent } from "./directoryContent.js";
import { importSkillSyncItems } from "./skillDataSyncImport.js";
import {
  findParentSkill,
  getSkillDataSyncConfigPath,
  isSkillEnabled,
  readSkillEnabledOverrides,
  readSkillStoreVersion,
  resolveUserSkills,
  type ResolvedUserSkill,
} from "./skillDataSyncShared.js";

const logger = createServiceLogger("skill-data-sync");

export function createSkillDataSyncMethods(options: {
  maxItemBytes: number;
}): IDataSyncCategoryService<SkillDataSyncPayload> {
  const { maxItemBytes } = options;

  async function listItem(
    skill: ResolvedUserSkill,
    overrides: Record<string, unknown>,
    parentKey: string | undefined,
  ): Promise<DataSyncListItem> {
    const contentRoot = await realpath(skill.directoryPath);
    const [scan, version] = await Promise.all([
      scanDirectoryContent(contentRoot),
      readSkillStoreVersion(contentRoot),
    ]);
    return {
      key: skill.key,
      name: skill.name,
      description: skill.description,
      ...(parentKey ? { parentKey } : {}),
      ...(version ? { version } : {}),
      signature: { fileCount: scan.fileCount, totalBytes: scan.totalBytes },
      enabled: isSkillEnabled(overrides, skill.skillFilePath),
      ...(scan.totalBytes > maxItemBytes
        ? { exportBlockedReason: "size-limit" as const }
        : scan.containsSymlink
          ? { exportBlockedReason: "contains-symlink" as const }
          : {}),
      ...(skill.location === "agents"
        ? { overwriteBlockedReason: "compat-directory" as const }
        : skill.isSymlink
          ? { overwriteBlockedReason: "target-symlink" as const }
          : {}),
    };
  }

  /** 超限项不计算哈希（性能措施：列表只给签名，哈希按需）。 */
  async function hashSkill(skill: ResolvedUserSkill): Promise<string | undefined> {
    const contentRoot = await realpath(skill.directoryPath);
    const scan = await scanDirectoryContent(contentRoot);
    return scan.totalBytes > maxItemBytes ? undefined : await hashDirectoryContent(contentRoot);
  }

  return {
    async listSyncItems() {
      const [skills, overrides] = await Promise.all([
        resolveUserSkills(),
        readSkillEnabledOverrides(),
      ]);
      const all = [...skills.values()];
      return {
        items: await Promise.all(
          all.map((skill) => listItem(skill, overrides, findParentSkill(skill, all)?.key)),
        ),
        homeDir: resolveUserHomeDir(),
      };
    },

    async getSyncContentHashes(params) {
      const skills = await resolveUserSkills();
      const hashes: Record<string, string> = {};
      await Promise.all(
        params.keys.map(async (key) => {
          const skill = skills.get(key);
          const hash = skill ? await hashSkill(skill) : undefined;
          if (hash) hashes[key] = hash;
        }),
      );
      return { hashes };
    },

    async checkSyncWriteAccess() {
      return await checkRemoteSyncDirectoriesWriteAccess([
        getUserZcodeSkillRoot(),
        dirname(getSkillDataSyncConfigPath()),
      ]);
    },

    async exportSyncItems(params) {
      const [skills, overrides] = await Promise.all([
        resolveUserSkills(),
        readSkillEnabledOverrides(),
      ]);
      const selected = params.keys.map((key) => {
        const skill = skills.get(key);
        if (!skill) throw new Error(`skill sync item not found: ${key}`);
        return skill;
      });
      // 父子技能同时选中时只打包最上层的选中目录；子技能的文件已在上级目录里，
      // 归档里不再重复一份字节。payload items 仍列出全部选中项。
      const packed = selected.filter(
        (skill) =>
          !selected.some(
            (other) => other !== skill && isPathWithin(other.directoryPath, skill.directoryPath),
          ),
      );
      const entries = await Promise.all(
        packed.map(async (skill) => {
          const sourcePath = await realpath(skill.directoryPath);
          const scan = await scanDirectoryContent(sourcePath);
          if (scan.totalBytes > maxItemBytes) {
            throw createSkillSyncSizeLimitError({
              actualBytes: scan.totalBytes,
              maxBytes: maxItemBytes,
              phase: "selected-content",
            });
          }
          return { sourcePath, archivePath: skill.directoryName };
        }),
      );
      const archive = await createSkillSyncArchive(entries);
      if (archive.byteLength > maxItemBytes) {
        throw createSkillSyncSizeLimitError({
          actualBytes: archive.byteLength,
          maxBytes: maxItemBytes,
          phase: "archive",
        });
      }
      return {
        archive,
        sourceHomeDir: resolveUserHomeDir(),
        items: selected.map((skill) => ({
          key: skill.key,
          name: skill.name,
          directoryName: skill.directoryName,
          enabled: isSkillEnabled(overrides, skill.skillFilePath),
        })),
      };
    },

    async importSyncItems(params) {
      try {
        return await importSkillSyncItems({
          payload: params.payload,
          items: params.items,
          maxItemBytes,
        });
      } catch (error) {
        // 解压/归档超限或目标根不可写：整类失败，不逐项猜测。
        logger.warn(undefined, "技能数据同步导入失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}
