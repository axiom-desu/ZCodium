import {
  compareSemverVersions,
  type DataSyncBlockedReason,
  type DataSyncImportMode,
  type DataSyncItemDependencies,
  type DataSyncListItem,
  type DataSyncModelOverrideSummary,
} from "@zcode/shared";

/**
 * 数据同步比较（上游 docs/remote/data-sync.md「行状态与默认选择」）。纯函数，不做 IO。
 * 推送模式下：source = 本机，target = 设备。
 */
export type DataSyncRowStatus = "push" | "update" | "difference" | "synced" | "blocked";

export type DataSyncRowNote =
  | { kind: "metadata" }
  | { kind: "version"; from: string; to: string }
  | { kind: "sourceOlder" }
  | { kind: "contentDiffers" }
  | { kind: "blocked"; reason: DataSyncBlockedReason };

export interface DataSyncRow {
  key: string;
  name: string;
  description?: string;
  status: DataSyncRowStatus;
  note: DataSyncRowNote;
  selectable: boolean;
  defaultSelected: boolean;
  importMode?: DataSyncImportMode;
  expectedTargetHash?: string;
  /** 来源端字节数，用于按批次导出。 */
  totalBytes: number;
  /** 子智能体分类：来源项引用的 MCP / 技能，用于行内依赖提示。 */
  dependencies?: DataSyncItemDependencies;
  /** 技能分类：来源端目录包含本项的最近一个技能，用于推送时父子同批。 */
  parentKey?: string;
  /** 子智能体分类：内置智能体的模型覆盖行。 */
  builtInModelOverride?: {
    source: DataSyncModelOverrideSummary;
    target?: DataSyncModelOverrideSummary;
  };
}

interface DataSyncHashRequests {
  sourceKeys: string[];
  targetKeys: string[];
}

const STATUS_ORDER: Record<DataSyncRowStatus, number> = {
  push: 0,
  update: 1,
  difference: 2,
  synced: 3,
  blocked: 4,
};

function signatureKey(item: DataSyncListItem): string {
  return item.signature ? `${item.signature.fileCount}:${item.signature.totalBytes}` : "";
}

/** 两端都有版本号时比较；返回 null 表示版本不能决定结果（缺失、相同或不能解析）。 */
function compareVersions(source: DataSyncListItem, target: DataSyncListItem): number | null {
  if (!source.version || !target.version) return null;
  const result = compareSemverVersions(source.version, target.version);
  return result === null || result === 0 ? null : result;
}

function isComparable(source: DataSyncListItem, target: DataSyncListItem | undefined): boolean {
  return Boolean(target) && !source.exportBlockedReason && !target!.overwriteBlockedReason;
}

/**
 * 哈希请求（性能措施 1–3）：只针对两端都有且能同步的项。
 * - 目标端：全部计算，作为覆盖时的 expectedTargetHash（并发基线）。
 * - 来源端：只在签名相同、版本不能决定结果时计算，用于判断「已同步 / 内容不同」。
 * list 已带 contentHash 的条目不再请求；目标端整类不能导入时不请求任何哈希。
 */
export function selectDataSyncHashRequests(
  sourceItems: readonly DataSyncListItem[],
  targetItems: readonly DataSyncListItem[],
  targetBlockedReason?: DataSyncBlockedReason,
): DataSyncHashRequests {
  if (targetBlockedReason) return { sourceKeys: [], targetKeys: [] };
  const targetByKey = new Map(targetItems.map((item) => [item.key, item]));
  const sourceKeys: string[] = [];
  const targetKeys: string[] = [];
  for (const source of sourceItems) {
    const target = targetByKey.get(source.key);
    // 只按版本比较的条目（marketplace 插件）不计算哈希。
    if (!target || source.versionOnly || !isComparable(source, target)) continue;
    if (!target.contentHash) targetKeys.push(source.key);
    if (
      !source.contentHash &&
      compareVersions(source, target) === null &&
      signatureKey(source) === signatureKey(target)
    ) {
      sourceKeys.push(source.key);
    }
  }
  return { sourceKeys, targetKeys };
}

function compareRow(
  source: DataSyncListItem,
  target: DataSyncListItem | undefined,
  sourceHashes: Readonly<Record<string, string>>,
  targetHashes: Readonly<Record<string, string>>,
  targetBlockedReason: DataSyncBlockedReason | undefined,
): Omit<
  DataSyncRow,
  | "key"
  | "name"
  | "description"
  | "totalBytes"
  | "dependencies"
  | "parentKey"
  | "builtInModelOverride"
> {
  const blockedReason =
    targetBlockedReason ?? source.exportBlockedReason ?? target?.overwriteBlockedReason;
  if (blockedReason) {
    return {
      status: "blocked",
      note: { kind: "blocked", reason: blockedReason },
      selectable: false,
      defaultSelected: false,
    };
  }
  if (!target) {
    return {
      status: "push",
      note: { kind: "metadata" },
      selectable: true,
      defaultSelected: true,
      importMode: "createOnly",
    };
  }
  if (source.versionOnly) return compareVersionOnlyRow(source, target);
  const expectedTargetHash = target.contentHash ?? targetHashes[source.key];
  const overwrite = {
    importMode: "overwrite" as const,
    ...(expectedTargetHash ? { expectedTargetHash } : {}),
  };
  const versionResult = compareVersions(source, target);
  if (versionResult !== null) {
    return versionResult > 0
      ? {
          status: "update",
          note: { kind: "version", from: target.version!, to: source.version! },
          selectable: true,
          defaultSelected: true,
          ...overwrite,
        }
      : {
          status: "difference",
          note: { kind: "sourceOlder" },
          selectable: true,
          defaultSelected: false,
          ...overwrite,
        };
  }
  const sourceHash = source.contentHash ?? sourceHashes[source.key];
  const sameContent =
    signatureKey(source) === signatureKey(target) &&
    Boolean(sourceHash) &&
    sourceHash === expectedTargetHash;
  return sameContent
    ? { status: "synced", note: { kind: "metadata" }, selectable: false, defaultSelected: false }
    : {
        status: "difference",
        note: { kind: "contentDiffers" },
        selectable: true,
        defaultSelected: false,
        ...overwrite,
      };
}

/**
 * 只按版本比较（marketplace 插件）：版本相同即已同步；设备较新时显示差异但不可勾选（不能指定版本或降级）；
 * 其余情况只有目标端来源的最新版本正好等于来源版本时才能更新，否则不能同步。
 */
function compareVersionOnlyRow(
  source: DataSyncListItem,
  target: DataSyncListItem,
): Omit<DataSyncRow, "key" | "name" | "description" | "totalBytes"> {
  if (source.version === target.version) {
    return {
      status: "synced",
      note: { kind: "metadata" },
      selectable: false,
      defaultSelected: false,
    };
  }
  const versionResult = compareVersions(source, target);
  if (versionResult !== null && versionResult < 0) {
    return {
      status: "difference",
      note: { kind: "sourceOlder" },
      selectable: false,
      defaultSelected: false,
    };
  }
  if (!source.version || target.latestVersion !== source.version) {
    return {
      status: "blocked",
      note: { kind: "blocked", reason: "remote-latest-mismatch" },
      selectable: false,
      defaultSelected: false,
    };
  }
  return {
    status: "update",
    note: target.version
      ? { kind: "version", from: target.version, to: source.version }
      : { kind: "metadata" },
    selectable: true,
    defaultSelected: true,
    importMode: "overwrite",
  };
}

/**
 * 生成本机条目的行；设备独有的条目不展示，也永不删除。排序：推送 → 更新 → 差异 → 已同步 → 不能同步。
 * `targetBlockedReason`：目标端整类不能导入（例如设备 MCP 使用 `~/.agents` 兼容配置），所有行都不可选。
 */
export function compareDataSyncItems(params: {
  sourceItems: readonly DataSyncListItem[];
  targetItems: readonly DataSyncListItem[];
  sourceHashes: Readonly<Record<string, string>>;
  targetHashes: Readonly<Record<string, string>>;
  targetBlockedReason?: DataSyncBlockedReason;
}): DataSyncRow[] {
  const targetByKey = new Map(params.targetItems.map((item) => [item.key, item]));
  return params.sourceItems
    .map((source) => {
      const target = targetByKey.get(source.key);
      const row = compareRow(
        source,
        target,
        params.sourceHashes,
        params.targetHashes,
        params.targetBlockedReason,
      );
      const targetOverride = row.status === "difference" ? target?.builtInModelOverride : undefined;
      return {
        key: source.key,
        name: source.name,
        ...(source.description ? { description: source.description } : {}),
        totalBytes: source.signature?.totalBytes ?? 0,
        ...(source.dependencies ? { dependencies: source.dependencies } : {}),
        ...(source.parentKey ? { parentKey: source.parentKey } : {}),
        ...(source.builtInModelOverride
          ? {
              builtInModelOverride: {
                source: source.builtInModelOverride,
                ...(targetOverride ? { target: targetOverride } : {}),
              },
            }
          : {}),
        ...row,
      };
    })
    .sort(
      (left, right) =>
        STATUS_ORDER[left.status] - STATUS_ORDER[right.status] ||
        left.name.localeCompare(right.name),
    );
}

export interface DataSyncMissingDependencies {
  mcpServers: string[];
  skills: string[];
}

/** MCP 与技能分类的对齐 key 都是名称 trim + 小写。 */
function toDependencyKey(name: string): string {
  return name.trim().toLowerCase();
}

/** 依赖分类两端的条目 key（含各端独有项）。 */
interface DataSyncDependencyKeys {
  source: ReadonlySet<string>;
  target: ReadonlySet<string>;
}

/**
 * 依赖提示：引用的 MCP / 技能在本机对应列表中存在、且不在目标端列表中，才算设备缺少。
 * 两端列表取自同一弹窗中对应分类的加载结果，不额外请求；某分类未就绪时传 undefined，不对该类做判断。
 * 只用于行内提示，不影响行状态与勾选。没有缺失项时返回 undefined。
 */
export function findMissingDataSyncDependencies(
  dependencies: DataSyncItemDependencies | undefined,
  categoryKeys: {
    mcp: DataSyncDependencyKeys | undefined;
    skills: DataSyncDependencyKeys | undefined;
  },
): DataSyncMissingDependencies | undefined {
  if (!dependencies) return undefined;
  // 只提示本机列表里有（用户能在本弹窗推送）而目标端没有的依赖：
  // 内置技能、插件提供的技能 / MCP 不在用户列表中，不能误报为设备缺少。
  const missing = (
    names: readonly string[] | undefined,
    keys: DataSyncDependencyKeys | undefined,
  ) =>
    keys
      ? (names ?? []).filter((name) => {
          const key = toDependencyKey(name);
          return keys.source.has(key) && !keys.target.has(key);
        })
      : [];
  const result = {
    mcpServers: missing(dependencies.mcpServers, categoryKeys.mcp),
    skills: missing(dependencies.skills, categoryKeys.skills),
  };
  return result.mcpServers.length > 0 || result.skills.length > 0 ? result : undefined;
}
