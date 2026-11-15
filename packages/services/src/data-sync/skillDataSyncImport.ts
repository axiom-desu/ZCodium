import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  DataSyncImportItem,
  DataSyncImportResultItem,
  SkillDataSyncPayload,
} from "@zcode/shared";
import { pathExists, updateJsonObjectFile } from "#src/fs/atomicFileUtils.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { extractSkillSyncArchive } from "#src/skill-sync/skillSyncArchive.js";
import { createSkillSyncSizeLimitError } from "#src/skill-sync/skillSyncErrors.js";
import { resolveSkillSyncPathWithin } from "#src/skill-sync/skillSyncPath.js";
import {
  getUserZcodeSkillRoot,
  normalizeSkillNameKey,
  readSkillFileOrNull,
} from "#src/skill-sync/skillSyncService.js";
import { hashDirectoryContent, isPathWithin } from "./directoryContent.js";
import {
  getSkillDataSyncConfigPath,
  isSkillEnabled,
  normalizeSkillConfigPath,
  parsePayloadSkillName,
  readSkillEnabledOverrides,
  resolveUserSkills,
  SKILL_FILE_NAME,
  type ResolvedUserSkill,
} from "./skillDataSyncShared.js";
import { errorMessage } from "./syncUtils.js";

const logger = createServiceLogger("skill-data-sync");

/** 本次导入中已写入目标端的技能：来源相对目录（`/` 分隔）→ 目标端落位目录。 */
interface PlacedSkill {
  directoryName: string;
  path: string;
}

function directoryDepth(directoryName: string | undefined): number {
  return directoryName ? directoryName.split("/").length : 0;
}

/** 来源目录包含 `directoryName` 的最近一个已落位技能。 */
function findPlacedAncestor(
  placed: readonly PlacedSkill[],
  directoryName: string,
): PlacedSkill | undefined {
  let nearest: PlacedSkill | undefined;
  for (const candidate of placed) {
    if (
      directoryName.startsWith(`${candidate.directoryName}/`) &&
      (!nearest || candidate.directoryName.length > nearest.directoryName.length)
    ) {
      nearest = candidate;
    }
  }
  return nearest;
}

async function importOne(params: {
  item: DataSyncImportItem;
  index: number;
  payloadItem: SkillDataSyncPayload["items"][number] | undefined;
  incomingRoot: string;
  tempRoot: string;
  targetRoot: string;
  current: Map<string, ResolvedUserSkill>;
  /** 本次导入中已写入目标端、来源目录包含本项目录的最近上级。 */
  placedAncestor: PlacedSkill | undefined;
  /** 还原备份失败时调用：临时目录里留着原内容，不能删除。 */
  keepTempRoot: () => void;
}): Promise<DataSyncImportResultItem & { createdPath?: string }> {
  const { item, payloadItem, current, placedAncestor } = params;
  const failed = (error: string) => ({ key: item.key, status: "failed" as const, error });
  if (!payloadItem) return failed("skill is missing from the sync payload");
  // 本项目录在已落位上级之内：文件已随上级目录写入，位置 = 上级落位路径 + 相对路径。
  const followedPath = placedAncestor
    ? resolveSkillSyncPathWithin(
        placedAncestor.path,
        payloadItem.directoryName.slice(placedAncestor.directoryName.length + 1),
      )
    : undefined;
  const extractedPath =
    followedPath ?? resolveSkillSyncPathWithin(params.incomingRoot, payloadItem.directoryName);
  const content = await readSkillFileOrNull(join(extractedPath, SKILL_FILE_NAME));
  if (content === null) return failed("SKILL.md is missing");
  // 缺省名称两侧都取目录最后一段（`group/plain` → `plain`），嵌套且没有 frontmatter name 时 key 才一致。
  const metadataName = parsePayloadSkillName(content, payloadItem.directoryName);
  if (normalizeSkillNameKey(metadataName) !== item.key) {
    return failed("skill name does not match the sync key");
  }
  const existing = current.get(item.key);

  if (followedPath) {
    // 目标端原来已有该技能（在其他目录）：不覆盖它；随上级写入的这份文件留在上级目录里。
    if (existing) {
      return failed(
        `written along with its parent skill, but the target already has this skill at ${existing.directoryPath}; it was not overwritten`,
      );
    }
    return { key: item.key, status: "created", createdPath: followedPath };
  }

  if (item.mode === "createOnly") {
    // 列表加载后目标端出现同名技能：不写入，提示刷新后重试。
    if (existing) return { key: item.key, status: "conflict" };
    const targetPath = resolveSkillSyncPathWithin(params.targetRoot, payloadItem.directoryName);
    // 直接 rename：目标是非空目录、文件或软链时失败，失败后再用 lstat 判断是不是「已被占用」
    // （空目录会被直接替换，里面没有内容可丢；existsSync 会跟随软链，悬空软链被当成空位）。
    try {
      await mkdir(dirname(targetPath), { recursive: true });
      await rename(extractedPath, targetPath);
      return { key: item.key, status: "created", createdPath: targetPath };
    } catch (error) {
      if (await pathExists(targetPath)) return failed(`target path already exists: ${targetPath}`);
      return failed(errorMessage(error));
    }
  }

  if (!existing) return { key: item.key, status: "conflict" };
  if (existing.location !== "zcode" || existing.isSymlink) {
    return failed(`target cannot be overwritten: ${existing.directoryPath}`);
  }
  // 覆盖是整目录替换：先检查目标端是否有其他技能嵌套在该目录里（父目录哈希包含子目录，
  // expectedTargetHash 防不住），有则该项失败、目录不动。
  const nested = [...current.values()].find(
    (skill) => skill !== existing && isPathWithin(existing.directoryPath, skill.directoryPath),
  );
  if (nested) {
    return failed(`target directory contains another skill: ${nested.directoryPath}`);
  }
  const currentHash = await hashDirectoryContent(existing.directoryPath);
  if (!item.expectedTargetHash || currentHash !== item.expectedTargetHash) {
    return { key: item.key, status: "conflict" };
  }
  // 覆盖：新目录已解压在同盘临时目录；原目录先改名为备份，再把新目录换上。
  // 换上失败时把备份改回原位，目标保持原样；成功后备份随临时目录删除。
  const backupPath = join(params.tempRoot, `backup-${params.index}`);
  try {
    await rename(existing.directoryPath, backupPath);
  } catch (error) {
    return failed(errorMessage(error));
  }
  try {
    await rename(extractedPath, existing.directoryPath);
    return { key: item.key, status: "updated" };
  } catch (error) {
    const message = errorMessage(error);
    try {
      await rename(backupPath, existing.directoryPath);
    } catch (restoreError) {
      // 还原失败时不能删临时目录，否则备份（原内容）随之丢失；保留并写明位置交给用户恢复。
      params.keepTempRoot();
      logger.error(undefined, "技能覆盖失败且还原备份失败，已保留备份", {
        target: existing.directoryPath,
        backupPath,
        error: message,
        restoreError: errorMessage(restoreError),
      });
      return failed(
        `${message}; restoring the original failed, original content kept at ${backupPath}`,
      );
    }
    return failed(message);
  }
}

/**
 * 启用状态：新建项带上来源的启用状态，键换算为目标端 SKILL.md 路径；更新项不动，保留目标端状态。
 * config.json 写入失败（例如文件损坏）时删除需要写状态的新建项目录并标为失败，避免远端出现状态不对的技能。
 * 来源启用时删除该 key（开启态不落盘）；目标端同路径残留的 disable 也按来源状态更正。
 */
async function applyCreatedEnabledState(
  results: Array<DataSyncImportResultItem & { createdPath?: string }>,
  payloadByKey: Map<string, SkillDataSyncPayload["items"][number]>,
): Promise<void> {
  const overrides = await readSkillEnabledOverrides();
  const entries = results.flatMap((result) => {
    if (result.status !== "created" || !result.createdPath) return [];
    const skillFilePath = join(result.createdPath, SKILL_FILE_NAME);
    const disabled = payloadByKey.get(result.key)?.enabled === false;
    return disabled === !isSkillEnabled(overrides, skillFilePath)
      ? []
      : [{ result, configKey: normalizeSkillConfigPath(skillFilePath), disabled }];
  });
  if (entries.length === 0) return;
  try {
    await updateJsonObjectFile(getSkillDataSyncConfigPath(), (config) => {
      const next = { ...config };
      const skills =
        config.skills && typeof config.skills === "object" && !Array.isArray(config.skills)
          ? { ...(config.skills as Record<string, unknown>) }
          : {};
      for (const { configKey, disabled } of entries) {
        if (disabled) skills[configKey] = { enable: false };
        else delete skills[configKey];
      }
      if (Object.keys(skills).length > 0) next.skills = skills;
      else delete next.skills;
      return next;
    });
  } catch (error) {
    const removed = entries.map(({ result }) => result.createdPath!);
    for (const { result } of entries) {
      await rm(result.createdPath!, { recursive: true, force: true });
      result.status = "failed";
      result.error = errorMessage(error);
    }
    // 随被删除的上级目录一起写入的下级新建项，文件也已不在，同样标为失败。
    for (const result of results) {
      if (
        result.status === "created" &&
        result.createdPath &&
        removed.some((path) => isPathWithin(path, result.createdPath!))
      ) {
        result.status = "failed";
        result.error = errorMessage(error);
      }
    }
  }
}

/** 技能分类的导入实现：解压 → 逐项按来源层级写入 → 只对新建项应用启用状态。 */
export async function importSkillSyncItems(params: {
  payload: SkillDataSyncPayload;
  items: DataSyncImportItem[];
  maxItemBytes: number;
}): Promise<{ results: DataSyncImportResultItem[] }> {
  if (params.payload.archive.byteLength > params.maxItemBytes) {
    throw createSkillSyncSizeLimitError({
      actualBytes: params.payload.archive.byteLength,
      maxBytes: params.maxItemBytes,
      phase: "archive",
    });
  }
  const targetRoot = getUserZcodeSkillRoot();
  await mkdir(targetRoot, { recursive: true });
  // 临时目录放在技能根内，保证与目标同盘，rename 是原子替换。点目录不会被技能扫描读到。
  const tempRoot = join(targetRoot, `.sync-tmp-${randomUUID()}`);
  const incomingRoot = join(tempRoot, "incoming");
  let keepTempRoot = false;
  try {
    await extractSkillSyncArchive(params.payload.archive, incomingRoot, {
      maxExtractedBytes: params.maxItemBytes,
    });
    const current = await resolveUserSkills();
    const payloadByKey = new Map(params.payload.items.map((item) => [item.key, item]));
    const results: Array<DataSyncImportResultItem & { createdPath?: string }> = [];
    // 来源嵌套（parent 与 parent/child 同推）时按来源目录层级先上级后下级处理，并记录已落位的上级；
    // 下级在已落位上级之内时，文件已随上级写入，按「上级落位路径 + 相对路径」确认结果。
    const placed: PlacedSkill[] = [];
    const ordered = [...params.items.entries()].sort(
      ([, left], [, right]) =>
        directoryDepth(payloadByKey.get(left.key)?.directoryName) -
        directoryDepth(payloadByKey.get(right.key)?.directoryName),
    );
    for (const [index, item] of ordered) {
      const payloadItem = payloadByKey.get(item.key);
      const result = await importOne({
        item,
        index,
        payloadItem,
        incomingRoot,
        tempRoot,
        targetRoot,
        current,
        placedAncestor: payloadItem
          ? findPlacedAncestor(placed, payloadItem.directoryName)
          : undefined,
        keepTempRoot: () => {
          keepTempRoot = true;
        },
      });
      results[index] = result;
      const placedPath =
        result.status === "created"
          ? result.createdPath
          : result.status === "updated"
            ? current.get(item.key)?.directoryPath
            : undefined;
      if (payloadItem && placedPath) {
        placed.push({ directoryName: payloadItem.directoryName, path: placedPath });
      }
    }
    await applyCreatedEnabledState(results, payloadByKey);
    return { results: results.map(({ createdPath: _createdPath, ...result }) => result) };
  } finally {
    if (!keepTempRoot) await rm(tempRoot, { recursive: true, force: true });
  }
}
