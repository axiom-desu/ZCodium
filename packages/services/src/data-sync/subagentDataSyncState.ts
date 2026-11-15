import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentStateId,
  modelSelectionSchema,
  type BuiltInSubagentModelSelectionOverrides,
  type BuiltInSubagentName,
  type DataSyncImportStatus,
  type ModelSelection,
} from "@zcode/shared";
import { migrateSubagentStateFile, migrateUserSubagentMarkdown } from "@zcode/shared/node";
import { pathExists, updateJsonObjectFile } from "#src/fs/atomicFileUtils.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { parseSubagentMarkdown } from "#src/subagents/subagentMarkdown.js";
import { normalizeSubagentModelSelection } from "#src/subagents/subagentModelSelection.js";
import {
  resolveSubagentStateFile,
  resolveUserSubagentRoot,
} from "#src/subagents/subagentStorage.js";
import { stableStringify } from "./syncUtils.js";

const logger = createServiceLogger("subagent-data-sync");

export const AGENT_FILE_NAME = /^[^/\\]+\.(md|markdown)$/iu;
export const BUILT_IN_AGENT_NAMES: readonly BuiltInSubagentName[] = ["general-purpose", "Explore"];

export interface ResolvedUserSubagent {
  key: string;
  name: string;
  description: string;
  filePath: string;
  skills?: readonly string[];
  mcpServers?: readonly unknown[];
  /** 迁移之后的文件字节。 */
  content: Buffer;
}

export interface ResolvedBuiltInOverride {
  key: string;
  name: BuiltInSubagentName;
  modelSelection: ModelSelection;
  hash: string;
}

export function hashContent(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function toSubagentKey(name: string): string {
  return name.trim().toLowerCase();
}

export function toUserAgentStateId(key: string): string {
  return createAgentStateId({ name: key, scope: "user", source: "user" });
}

/** 内置智能体模型覆盖行的对齐 key：状态 ID 带 `built-in:` 前缀，不会与用户子智能体的 key 相同。 */
export function toBuiltInOverrideKey(name: BuiltInSubagentName): string {
  return createAgentStateId({ name, scope: "built-in", source: "built-in" });
}

export const BUILT_IN_OVERRIDE_KEYS = new Set(BUILT_IN_AGENT_NAMES.map(toBuiltInOverrideKey));

/**
 * 递归收集用户 agent 根下的 markdown 文件。设置服务的同一实现没有导出，
 * 这里保持同样的读取规则（真实目录、`.md/.markdown`），不做软链目录递归。
 */
async function collectAgentMarkdownPaths(rootPath: string): Promise<string[]> {
  if (!(await pathExists(rootPath))) return [];
  const rootStat = await lstat(rootPath).catch(() => undefined);
  if (!rootStat?.isDirectory()) return [];
  const result: string[] = [];
  for (const entry of await readdir(rootPath, { withFileTypes: true })) {
    const entryPath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await collectAgentMarkdownPaths(entryPath)));
      continue;
    }
    if (entry.isFile() && AGENT_FILE_NAME.test(entry.name)) result.push(entryPath);
  }
  return result;
}

/** 状态文件里的内置覆盖只认两个已知内置智能体；无效值忽略（与设置服务同一规则）。 */
export function normalizeBuiltInSelectionOverrides(
  structured: unknown,
): BuiltInSubagentModelSelectionOverrides {
  const result: BuiltInSubagentModelSelectionOverrides = {};
  const structuredRecord =
    typeof structured === "object" && structured !== null && !Array.isArray(structured)
      ? (structured as Record<string, unknown>)
      : {};
  const generalPurpose = modelSelectionSchema.safeParse(structuredRecord["general-purpose"]).data;
  const explore = modelSelectionSchema.safeParse(structuredRecord.Explore).data;
  if (generalPurpose) result["general-purpose"] = generalPurpose;
  if (explore) result.Explore = explore;
  return result;
}

/** 只有设了覆盖的内置智能体才是条目；继承默认的不列出，也就不会被推送或清除。 */
export function resolveBuiltInOverrides(
  overrides: BuiltInSubagentModelSelectionOverrides,
): Map<string, ResolvedBuiltInOverride> {
  const resolved = new Map<string, ResolvedBuiltInOverride>();
  for (const name of BUILT_IN_AGENT_NAMES) {
    const modelSelection = normalizeSubagentModelSelection(overrides[name]);
    if (!modelSelection) continue;
    const key = toBuiltInOverrideKey(name);
    resolved.set(key, {
      key,
      name,
      modelSelection,
      hash: createHash("sha256").update(stableStringify(modelSelection)).digest("hex"),
    });
  }
  return resolved;
}

/**
 * 本端用户子智能体，按 name 转小写对齐。根目录按本端 config.json 的 storage.dir 解析，两端可以不同。
 * 先完成本端 markdown 迁移再读字节：未迁移的一端与已迁移的一端内容实际相同，不先迁移会被误判为
 * 「内容不同」。同名时保留排序中的第一个文件。
 */
export async function resolveUserSubagents(): Promise<{
  root: string;
  agents: Map<string, ResolvedUserSubagent>;
}> {
  const root = await resolveUserSubagentRoot();
  const migration = await migrateUserSubagentMarkdown(root);
  for (const failure of migration.failures) {
    logger.warn(undefined, "用户 Subagent Markdown 迁移失败，按原文件计算", failure);
  }
  const agents = new Map<string, ResolvedUserSubagent>();
  for (const filePath of await collectAgentMarkdownPaths(root)) {
    const content = await readFile(filePath);
    const parsed = parseSubagentMarkdown({
      content: content.toString("utf-8"),
      path: filePath,
      scope: "user",
    }).agent;
    if (!parsed) continue;
    const key = toSubagentKey(parsed.name);
    if (agents.has(key)) continue;
    const model = parsed.modelSelection?.modelId;
    agents.set(key, {
      key,
      name: parsed.name,
      description: model ? `${model} · ${parsed.description}` : parsed.description,
      filePath,
      ...(parsed.skills ? { skills: parsed.skills } : {}),
      ...(parsed.mcpServers ? { mcpServers: parsed.mcpServers } : {}),
      content,
    });
  }
  return { root, agents };
}

/** 只读展示：状态文件缺失或损坏时视为全部启用、没有内置覆盖。写入走 updateJsonObjectFile。 */
export async function readSubagentState(): Promise<{
  disabled: Set<string>;
  builtInOverrides: Map<string, ResolvedBuiltInOverride>;
}> {
  const stateFile = await resolveSubagentStateFile();
  try {
    await migrateSubagentStateFile(stateFile);
    const parsed = JSON.parse(await readFile(stateFile, "utf-8")) as {
      disabledAgentIds?: unknown;
      builtInModelSelectionOverrides?: unknown;
    };
    return {
      disabled: new Set(
        Array.isArray(parsed.disabledAgentIds)
          ? parsed.disabledAgentIds.filter((id): id is string => typeof id === "string")
          : [],
      ),
      builtInOverrides: resolveBuiltInOverrides(
        normalizeBuiltInSelectionOverrides(parsed.builtInModelSelectionOverrides),
      ),
    };
  } catch {
    return { disabled: new Set(), builtInOverrides: new Map() };
  }
}

/**
 * 启用状态：新建项带上来源的禁用状态（`agents-state.json` 的 disabledAgentIds，键按 name，不用换算路径）；
 * 更新项不动，保留目标端状态。状态文件写入失败时删除本次需要改状态的新建项并标为失败，
 * 避免远端出现状态不对的子智能体。只处理来源状态与目标状态不一致的新建项。
 */
export async function applyCreatedSubagentEnabledState(
  results: Array<{
    key: string;
    status: DataSyncImportStatus;
    createdPath?: string;
    error?: string;
  }>,
  sourceEnabled: ReadonlyMap<string, boolean>,
): Promise<void> {
  const currentDisabled = (await readSubagentState()).disabled;
  const entries = results.flatMap((result) => {
    if (result.status !== "created" || !result.createdPath) return [];
    const id = toUserAgentStateId(result.key);
    const disabled = sourceEnabled.get(result.key) === false;
    return disabled === currentDisabled.has(id) ? [] : [{ result, id, disabled }];
  });
  if (entries.length === 0) return;
  const stateFile = await resolveSubagentStateFile();
  try {
    await migrateSubagentStateFile(stateFile);
    await updateJsonObjectFile(stateFile, (state) => {
      const disabledIds = new Set(
        Array.isArray(state.disabledAgentIds)
          ? state.disabledAgentIds.filter((id): id is string => typeof id === "string")
          : [],
      );
      for (const { id, disabled } of entries) {
        if (disabled) disabledIds.add(id);
        else disabledIds.delete(id);
      }
      return { ...state, disabledAgentIds: [...disabledIds].sort() };
    });
  } catch (error) {
    for (const { result } of entries) {
      await rm(result.createdPath!, { force: true });
      result.status = "failed";
      result.error = error instanceof Error ? error.message : String(error);
    }
  }
}
