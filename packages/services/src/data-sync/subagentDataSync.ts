import { lstat, mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  modelSelectionSchema,
  type BuiltInSubagentName,
  type DataSyncImportItem,
  type DataSyncImportResultItem,
  type DataSyncItemDependencies,
  type DataSyncListItem,
  type DataSyncModelOverrideSummary,
  type ModelSelection,
  type SubagentDataSyncPayload,
} from "@zcode/shared";
import { migrateSubagentStateFile } from "@zcode/shared/node";
import {
  pathExists,
  readJsonObjectFileForUpdate,
  updateJsonObjectFile,
  writeFileAtomically,
} from "#src/fs/atomicFileUtils.js";
import { checkRemoteSyncDirectoriesWriteAccess } from "#src/remote-sync/remoteSyncWriteAccess.js";
import { parseSubagentMarkdown } from "#src/subagents/subagentMarkdown.js";
import { normalizeSubagentModelSelection } from "#src/subagents/subagentModelSelection.js";
import {
  resolveSubagentStateFile,
  resolveUserHomeDir,
  resolveUserSubagentRoot,
} from "#src/subagents/subagentStorage.js";
import type { IDataSyncCategoryService } from "./contract.js";
import {
  AGENT_FILE_NAME,
  applyCreatedSubagentEnabledState,
  BUILT_IN_AGENT_NAMES,
  BUILT_IN_OVERRIDE_KEYS,
  hashContent,
  normalizeBuiltInSelectionOverrides,
  readSubagentState,
  resolveBuiltInOverrides,
  resolveUserSubagents,
  toBuiltInOverrideKey,
  toSubagentKey,
  toUserAgentStateId,
  type ResolvedBuiltInOverride,
  type ResolvedUserSubagent,
} from "./subagentDataSyncState.js";
import { errorMessage } from "./syncUtils.js";

/**
 * 依赖只认运行时支持的字符串名称（见 CLI `parseAgentMcpServers`）：MCP 的对象形式是内联配置，不依赖目标端。
 * skills 已由 parseSubagentMarkdown 归一为字符串列表。
 */
function resolveDependencies(agent: {
  skills?: readonly string[];
  mcpServers?: readonly unknown[];
}): DataSyncItemDependencies | undefined {
  const mcpServers = (agent.mcpServers ?? [])
    .filter((spec): spec is string => typeof spec === "string")
    .map((spec) => spec.trim())
    .filter(Boolean);
  const skills = agent.skills ?? [];
  if (mcpServers.length === 0 && skills.length === 0) return undefined;
  return {
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(skills.length > 0 ? { skills: [...skills] } : {}),
  };
}

function toModelOverrideSummary(selection: ModelSelection): DataSyncModelOverrideSummary {
  const reasoningLevel = selection.options?.reasoningLevel;
  return { modelId: selection.modelId, ...(reasoningLevel ? { reasoningLevel } : {}) };
}

interface ImportResult extends DataSyncImportResultItem {
  createdPath?: string;
}

async function importOne(
  item: DataSyncImportItem,
  payloadItem: SubagentDataSyncPayload["items"][number] | undefined,
  root: string,
  current: Map<string, ResolvedUserSubagent>,
): Promise<ImportResult> {
  const failed = (error: string) => ({ key: item.key, status: "failed" as const, error });
  if (!payloadItem) return failed("subagent is missing from the sync payload");
  if (!AGENT_FILE_NAME.test(payloadItem.fileName)) {
    return failed(`invalid subagent file name: ${payloadItem.fileName}`);
  }
  const content = Buffer.from(payloadItem.content);
  const parsed = parseSubagentMarkdown({
    content: content.toString("utf-8"),
    path: payloadItem.fileName,
    scope: "user",
  }).agent;
  if (!parsed || toSubagentKey(parsed.name) !== item.key) {
    return failed("subagent name does not match the sync key");
  }
  const existing = current.get(item.key);
  try {
    if (item.mode === "createOnly") {
      // 列表加载后目标端出现同名子智能体：不写入，提示刷新后重试。
      if (existing) return { key: item.key, status: "conflict" };
      const targetPath = join(root, payloadItem.fileName);
      if (await pathExists(targetPath)) return failed(`target path already exists: ${targetPath}`);
      await mkdir(root, { recursive: true });
      await writeFileAtomically(targetPath, content);
      return { key: item.key, status: "created", createdPath: targetPath };
    }
    if (!existing || !item.expectedTargetHash) return { key: item.key, status: "conflict" };
    if (hashContent(existing.content) !== item.expectedTargetHash) {
      return { key: item.key, status: "conflict" };
    }
    // 替换目标端该 name 对应的实际文件（文件名可能与来源不同），不另建新文件。
    const { mode } = await lstat(existing.filePath);
    await writeFileAtomically(existing.filePath, content, mode);
    return { key: item.key, status: "updated" };
  } catch (error) {
    return failed(errorMessage(error));
  }
}

interface BuiltInOverrideCandidate {
  item: DataSyncImportItem;
  name: BuiltInSubagentName;
  selection: ModelSelection;
}

/** 在状态文件内容上逐项核对目标端当前值；没有项通过核对时 changed 为 false。 */
function planBuiltInOverrideImport(
  state: Record<string, unknown>,
  candidates: readonly BuiltInOverrideCandidate[],
): { results: DataSyncImportResultItem[]; next: Record<string, unknown>; changed: boolean } {
  const current = resolveBuiltInOverrides(
    normalizeBuiltInSelectionOverrides(state.builtInModelSelectionOverrides),
  );
  const raw = state.builtInModelSelectionOverrides;
  const overrides: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  const results = candidates.map(({ item, name, selection }): DataSyncImportResultItem => {
    const existing = current.get(item.key);
    const conflict =
      item.mode === "createOnly"
        ? Boolean(existing)
        : !existing || !item.expectedTargetHash || existing.hash !== item.expectedTargetHash;
    if (conflict) return { key: item.key, status: "conflict" };
    overrides[name] = selection;
    return { key: item.key, status: item.mode === "createOnly" ? "created" : "updated" };
  });
  return {
    results,
    next: { ...state, builtInModelSelectionOverrides: overrides },
    changed: results.some((result) => result.status !== "conflict"),
  };
}

/**
 * 内置智能体模型覆盖的导入：迁移后逐项核对目标端当前值，只写通过核对的项；
 * 禁用状态、插件覆盖和未知字段原样保留。没有项通过核对时不写文件（冲突不写入）。
 * createOnly 时目标端已有覆盖、overwrite 时目标项哈希与 expectedTargetHash 不一致，都返回 conflict。
 * 不校验目标端是否有对应的 Provider 与模型，与用户子智能体 frontmatter 的 model 一致。
 */
async function importBuiltInModelOverrides(
  items: DataSyncImportItem[],
  payload: SubagentDataSyncPayload["builtInModelOverrides"],
): Promise<DataSyncImportResultItem[]> {
  if (items.length === 0) return [];
  const payloadByKey = new Map(payload.map((item) => [item.key, item]));
  const results = new Map<string, DataSyncImportResultItem>();
  const candidates: BuiltInOverrideCandidate[] = [];
  for (const item of items) {
    const payloadItem = payloadByKey.get(item.key);
    const selection = modelSelectionSchema.safeParse(payloadItem?.modelSelection).data;
    if (
      !payloadItem ||
      !selection ||
      !BUILT_IN_AGENT_NAMES.includes(payloadItem.name) ||
      toBuiltInOverrideKey(payloadItem.name) !== item.key
    ) {
      results.set(item.key, {
        key: item.key,
        status: "failed",
        error: "built-in subagent model override is missing or invalid in the sync payload",
      });
      continue;
    }
    candidates.push({
      item,
      name: payloadItem.name,
      selection: normalizeSubagentModelSelection(selection)!,
    });
  }
  if (candidates.length > 0) {
    const stateFile = await resolveSubagentStateFile();
    try {
      await migrateSubagentStateFile(stateFile);
      // 先在当前内容上试算：所有项都冲突时不重写远端状态文件（内容不变，字节与 mtime 也不变）。
      let planned = planBuiltInOverrideImport(
        await readJsonObjectFileForUpdate(stateFile),
        candidates,
      );
      if (planned.changed) {
        await updateJsonObjectFile(stateFile, (state) => {
          planned = planBuiltInOverrideImport(state, candidates);
          return planned.next;
        });
      }
      for (const result of planned.results) results.set(result.key, result);
    } catch (error) {
      for (const { item } of candidates) {
        results.set(item.key, { key: item.key, status: "failed", error: errorMessage(error) });
      }
    }
  }
  return items.map((item) => results.get(item.key)!);
}

export function createSubagentDataSyncMethods(): IDataSyncCategoryService<SubagentDataSyncPayload> {
  return {
    async listSyncItems() {
      const [{ agents }, { disabled, builtInOverrides }] = await Promise.all([
        resolveUserSubagents(),
        readSubagentState(),
      ]);
      const userItems: DataSyncListItem[] = [...agents.values()].map((agent) => {
        const dependencies = resolveDependencies(agent);
        return {
          key: agent.key,
          name: agent.name,
          description: agent.description,
          signature: { fileCount: 1, totalBytes: agent.content.byteLength },
          // 单个 markdown 文件，列表时已读入字节，哈希直接返回，比较时不再单独请求。
          contentHash: hashContent(agent.content),
          enabled: !disabled.has(toUserAgentStateId(agent.key)),
          ...(dependencies ? { dependencies } : {}),
        };
      });
      // 内置智能体的模型覆盖与用户子智能体放在同一个列表（不分组），哈希直接返回。
      const overrideItems: DataSyncListItem[] = [...builtInOverrides.values()].map(
        (override: ResolvedBuiltInOverride) => ({
          key: override.key,
          name: override.name,
          contentHash: override.hash,
          enabled: true,
          builtInModelOverride: toModelOverrideSummary(override.modelSelection),
        }),
      );
      return { items: [...userItems, ...overrideItems], homeDir: resolveUserHomeDir() };
    },

    async getSyncContentHashes(params) {
      const [{ agents }, { builtInOverrides }] = await Promise.all([
        resolveUserSubagents(),
        readSubagentState(),
      ]);
      const hashes: Record<string, string> = {};
      for (const key of params.keys) {
        const agent = agents.get(key);
        const hash = agent ? hashContent(agent.content) : builtInOverrides.get(key)?.hash;
        if (hash) hashes[key] = hash;
      }
      return { hashes };
    },

    async checkSyncWriteAccess() {
      return await checkRemoteSyncDirectoriesWriteAccess([
        await resolveUserSubagentRoot(),
        dirname(await resolveSubagentStateFile()),
      ]);
    },

    async exportSyncItems(params) {
      const [{ agents }, { disabled, builtInOverrides }] = await Promise.all([
        resolveUserSubagents(),
        readSubagentState(),
      ]);
      return {
        sourceHomeDir: resolveUserHomeDir(),
        builtInModelOverrides: params.keys
          .filter((key) => BUILT_IN_OVERRIDE_KEYS.has(key))
          .map((key) => {
            const override = builtInOverrides.get(key);
            if (!override) throw new Error(`subagent sync item not found: ${key}`);
            return { key, name: override.name, modelSelection: override.modelSelection };
          }),
        items: params.keys
          .filter((key) => !BUILT_IN_OVERRIDE_KEYS.has(key))
          .map((key) => {
            const agent = agents.get(key);
            if (!agent) throw new Error(`subagent sync item not found: ${key}`);
            return {
              key,
              name: agent.name,
              fileName: basename(agent.filePath),
              content: new Uint8Array(agent.content),
              enabled: !disabled.has(toUserAgentStateId(key)),
            };
          }),
      };
    },

    async importSyncItems(params) {
      // 目标端同样先迁移再计算哈希，与列表时给出的 expectedTargetHash 口径一致。
      const { root, agents } = await resolveUserSubagents();
      const payloadByKey = new Map(params.payload.items.map((item) => [item.key, item]));
      const sourceEnabled = new Map(
        params.payload.items.map((item) => [item.key, item.enabled] as const),
      );
      const results: ImportResult[] = [];
      for (const item of params.items) {
        if (BUILT_IN_OVERRIDE_KEYS.has(item.key)) continue;
        results.push(await importOne(item, payloadByKey.get(item.key), root, agents));
      }
      await applyCreatedSubagentEnabledState(results, sourceEnabled);
      const overrideResults = await importBuiltInModelOverrides(
        params.items.filter((item) => BUILT_IN_OVERRIDE_KEYS.has(item.key)),
        params.payload.builtInModelOverrides,
      );
      return {
        results: [
          ...results.map(({ createdPath: _createdPath, ...result }) => result),
          ...overrideResults,
        ],
      };
    },
  };
}
