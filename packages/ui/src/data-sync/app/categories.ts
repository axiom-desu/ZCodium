import {
  Anchor,
  Blocks,
  Bot,
  Cable,
  LayoutDashboard,
  Terminal,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import type { IDataSyncCategoryService, IServiceAccessor } from "@zcode/services";
import {
  PLUGIN_DATA_SYNC_MAX_ITEM_BYTES,
  SKILL_DATA_SYNC_MAX_ITEM_BYTES,
  type SourceServerWorkspaceHistoryEntry,
  type UserConfigSyncCategory,
} from "@zcode/shared";
import {
  refreshWorkspacePluginCapabilitiesAfterRemoteSync,
  refreshSlashCommandsAfterRemoteSync,
} from "@/lib/remotePluginSyncRefresh.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import {
  invalidateDeferredDraftSessionForRuntimeChange,
  invalidateDeferredDraftSessionForSkillChange,
} from "@/lib/zcodeDraftSkillInvalidation.js";
import { useMcpStore } from "@/store/mcpStore.js";
import { refreshLoadedSubagentsStoreForWorkspace } from "@/store/subagentsStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { DataSyncCategoryId } from "../contract.js";
import { selectTabsOnDevice } from "../domain/devices.js";
import {
  createPluginCategoryDataSyncService,
  type DataSyncPushControl,
} from "./pluginCategorySync.js";

export interface DataSyncAfterPushContext {
  sourceServerId: string;
  targetServices: IServiceAccessor;
  workspaceHistory?: readonly SourceServerWorkspaceHistoryEntry[];
  /** 当前窗口打开的 workspace tab，用于刷新该设备上项目的运行态。 */
  workspaceTabs?: readonly WorkspaceTabState[];
}

/**
 * 数据同步分类适配器。新增分类只需：服务实现 IDataSyncCategoryService → 在这里注册 → 文案
 * `dataSync.category.<id>`。导航顺序即数组顺序（设计稿：概览、模型提供商、子智能体、插件、MCP、技能、命令、钩子）。
 */
export interface DataSyncCategoryAdapter {
  id: DataSyncCategoryId;
  icon: LucideIcon;
  /**
   * 该端的分类服务。推送时弹窗为目标端传入 control，用于按行「停止」（marketplace 插件的目标端 add / install）。
   */
  getService(
    services: IServiceAccessor,
    control?: DataSyncPushControl,
  ): IDataSyncCategoryService<unknown>;
  /** 单次导出 / 导入的来源字节上限；超过时按批次串行推送。 */
  maxBatchBytes?: number;
  /** 推送结束后刷新依赖该分类的运行态（列表、草稿会话）。 */
  afterPush?(context: DataSyncAfterPushContext): Promise<void>;
}

export const DATA_SYNC_OVERVIEW_ICON = LayoutDashboard;

function tabsOnDevice(context: DataSyncAfterPushContext): WorkspaceTabState[] {
  return selectTabsOnDevice(
    context.workspaceTabs,
    context.workspaceHistory,
    context.sourceServerId,
  );
}

/** 刷新该设备上已打开 workspace 的技能列表，并使草稿会话失效（沿用旧技能同步入口的刷新逻辑）。 */
async function refreshSkillsAfterPush(context: DataSyncAfterPushContext): Promise<void> {
  for (const tab of tabsOnDevice(context)) {
    await invalidateDeferredDraftSessionForSkillChange({
      workspacePath: tab.workspacePath,
      workspaceIdentity: tab.workspaceIdentity,
      reason: "data-sync-skill-push",
      zcodeSessionService: context.targetServices.zcodeSessionService,
    });
    await refreshSharedSkillStoreForWorkspace({
      workspacePath: tab.workspacePath,
      workspaceIdentity: tab.workspaceIdentity,
      skillsService: context.targetServices.skillsService,
    });
  }
}

/**
 * 插件推送后复用旧插件同步入口的完整刷新链：依次刷新技能、slash commands、MCP，并发送插件管理通知。
 */
async function refreshPluginsAfterPush(context: DataSyncAfterPushContext): Promise<void> {
  const { targetServices } = context;
  for (const tab of tabsOnDevice(context)) {
    await refreshWorkspacePluginCapabilitiesAfterRemoteSync({
      commandsService: targetServices.commandsService,
      mcpSyncService: targetServices.mcpSyncService,
      reason: "data-sync-plugin-push",
      skillsService: targetServices.skillsService,
      workspaceIdentity: tab.workspaceIdentity,
      workspacePath: tab.workspacePath,
      zcodeAgentService: targetServices.zcodeAgentService,
      zcodeSessionService: targetServices.zcodeSessionService,
    });
  }
}

/** 用户配置同步通道（子智能体 / 命令 / 钩子共用）按 category 绑定成单个分类服务。 */
function bindUserConfigSyncCategory(
  services: IServiceAccessor,
  category: UserConfigSyncCategory,
): IDataSyncCategoryService<unknown> {
  const channel = services.userConfigSyncService;
  return {
    listSyncItems: () => channel.listSyncItems({ category }),
    getSyncContentHashes: ({ keys }) => channel.getSyncContentHashes({ category, keys }),
    checkSyncWriteAccess: () => channel.checkSyncWriteAccess({ category }),
    exportSyncItems: ({ keys }) => channel.exportSyncItems({ category, keys }),
    importSyncItems: ({ payload, items }) =>
      channel.importSyncItems({
        category,
        payload: payload as Parameters<typeof channel.importSyncItems>[0]["payload"],
        items,
      }),
  };
}

/**
 * 刷新该设备上已打开项目斜杠（/）建议中的子智能体。
 * 建议缓存按项目服务分桶，只有已挂载的桶会刷新（refreshLoadedSubagentsStoreForWorkspace）。
 */
async function refreshSubagentsAfterPush(context: DataSyncAfterPushContext): Promise<void> {
  for (const tab of tabsOnDevice(context)) {
    await refreshLoadedSubagentsStoreForWorkspace({
      workspacePath: tab.workspacePath,
      workspaceIdentity: tab.workspaceIdentity,
      subagentsService: context.targetServices.subagentsService,
    });
  }
}

/**
 * MCP 推送后只刷新全局 MCP store 当前指向的项目（不切换当前项目）。
 * 只有 store 已停在该 workspace 时才重读，否则会影响用户正在看的项目。
 */
async function refreshMcpAfterPush(context: DataSyncAfterPushContext): Promise<void> {
  const store = useMcpStore.getState();
  for (const tab of tabsOnDevice(context)) {
    const identity = tab.workspaceIdentity?.trim() || undefined;
    if (store.currentProjectPath !== tab.workspacePath) continue;
    if ((store.currentWorkspaceIdentity ?? undefined) !== identity) continue;
    await store.loadMcpFromUserDirectory(context.targetServices.mcpSyncService, identity);
  }
}

/**
 * 钩子推送后使该设备上已打开项目的预热会话失效，与设置页保存钩子（HooksSection）走同一入口：
 * 会话只在创建时读一次钩子，不作废预热会话会让首条消息不执行推送的钩子。
 */
async function refreshHooksAfterPush(context: DataSyncAfterPushContext): Promise<void> {
  for (const tab of tabsOnDevice(context)) {
    await invalidateDeferredDraftSessionForRuntimeChange({
      logScope: "hooks",
      reason: "data-sync-hook-push",
      workspacePath: tab.workspacePath,
      workspaceIdentity: tab.workspaceIdentity,
      zcodeSessionService: context.targetServices.zcodeSessionService,
    });
  }
}

/** 命令推送后刷新该设备上已打开项目的 slash commands（沿用插件同步后的命令刷新）。 */
async function refreshCommandsAfterPush(context: DataSyncAfterPushContext): Promise<void> {
  for (const tab of tabsOnDevice(context)) {
    await refreshSlashCommandsAfterRemoteSync({
      commandsService: context.targetServices.commandsService,
      reason: "data-sync-command-push",
      workspacePath: tab.workspacePath,
      workspaceIdentity: tab.workspaceIdentity?.trim() || null,
    });
  }
}

export const DATA_SYNC_CATEGORIES: readonly DataSyncCategoryAdapter[] = [
  {
    id: "subagents",
    icon: Bot,
    getService: (services) => bindUserConfigSyncCategory(services, "subagents"),
    afterPush: refreshSubagentsAfterPush,
  },
  // 插件分类 = inline 插件（pluginSyncService）+ marketplace 插件（插件管理服务的 add / install 编排）。
  {
    id: "plugins",
    icon: Blocks,
    getService: (services, control) => createPluginCategoryDataSyncService(services, control),
    maxBatchBytes: PLUGIN_DATA_SYNC_MAX_ITEM_BYTES,
    afterPush: refreshPluginsAfterPush,
  },
  {
    id: "mcp",
    icon: Cable,
    getService: (services) => services.mcpSyncService,
    afterPush: refreshMcpAfterPush,
  },
  {
    id: "skills",
    icon: WandSparkles,
    getService: (services) => services.skillSyncService,
    maxBatchBytes: SKILL_DATA_SYNC_MAX_ITEM_BYTES,
    afterPush: refreshSkillsAfterPush,
  },
  {
    id: "commands",
    icon: Terminal,
    getService: (services) => bindUserConfigSyncCategory(services, "commands"),
    afterPush: refreshCommandsAfterPush,
  },
  {
    id: "hooks",
    icon: Anchor,
    getService: (services) => bindUserConfigSyncCategory(services, "hooks"),
    afterPush: refreshHooksAfterPush,
  },
];

/** 分类适配器查询；未知 id 返回 undefined（UI 回退概览）。 */
export function findDataSyncCategory(id: string): DataSyncCategoryAdapter | undefined {
  return DATA_SYNC_CATEGORIES.find((category) => category.id === id);
}

export type { DataSyncPushControl };
