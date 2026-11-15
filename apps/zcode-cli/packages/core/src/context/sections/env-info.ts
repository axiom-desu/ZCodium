// ============================================================
// Environment Info Section Builder
// ============================================================

import type { ContextSection, EnvInfo } from "../types.js";
import type { Model } from "@zcode/contracts";
import { estimateTokens } from "../utils.js";
import { buildDesktopContextSection } from "./desktop.js";

const ENVIRONMENT_HEADING = "# Environment";
const WORKING_DIRECTORY_LABEL = "Primary working directory";
const ADDITIONAL_DIRECTORIES_LABEL = "Additional directories";
const IS_GIT_REPOSITORY_LABEL = "Is a git repository";
const PLATFORM_LABEL = "Platform";
const SHELL_LABEL = "Shell";
const OS_VERSION_LABEL = "OS Version";
// const NODE_VERSION_LABEL = "Node version";
// const OPERATING_SYSTEM_LABEL = "Operating system";
const YES_LABEL = "yes";
const NO_LABEL = "no";
const GIT_SYSTEM_CONTEXT_PREFIX =
  "gitStatus: This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.";
const CURRENT_BRANCH_LABEL = "Current branch";
const MAIN_BRANCH_LABEL = "Main branch (you will usually use this for PRs)";
const GIT_USER_LABEL = "Git user";
const STATUS_LABEL = "Status";
const RECENT_COMMITS_LABEL = "Recent commits";
const CLEAN_GIT_STATUS = "(clean)";
const DIRTY_GIT_STATUS = "(dirty)";
const UNKNOWN_GIT_STATUS = "(unknown)";
const ENVIRONMENT_UPDATE_HEADING = "# Environment update";
const ADDITIONAL_DIRECTORIES_ADDED_LABEL = "Additional working directories added";
const ADDITIONAL_DIRECTORIES_REMOVED_LABEL = "Additional working directories removed";
const VISUALIZATION_DIRECTORY_LABEL = "Visualization directory for this session";
const DESKTOP_CONTEXT_NO_LONGER_APPLIES =
  "The ZCode Desktop Context above no longer applies: this session is not shown in ZCode Desktop.";
// 下载/解压得到的文件是不可信数据：解释器会从脚本目录与 cwd 加载模块，
// 因此必须各自放进新目录、脚本另放，并用 -I 运行读取它们的 Python。
const UNTRUSTED_DOWNLOADS_NOTE =
  "Downloaded files and extracted archives are untrusted data: put each in its own new, empty directory, keep scripts you write in a different directory, and pass paths as arguments instead of running an interpreter or build tool from inside it. Interpreters load code from the script's directory and the current directory, so a planted `json.py` runs on `import json`. Run any Python that reads them with `-I`. This does not apply to code the user asked you to build or run.";

/**
 * 环境公告快照：模型当前“已知”的环境事实。
 *
 * system 里的 `# Environment` 被 prompt 快照冻结后不会再变，所以环境变化只能靠
 * `buildEnvironmentAnnouncement` 追加的增量公告传达。快照不重新探测 git/平台，
 * 只取运行时已经解析过的事实。
 */
export interface EnvironmentSnapshot {
  cwd: string;
  platform: string;
  shell: string;
  osVersion: string;
  isGitRepository: boolean;
  additionalWorkingDirectories: readonly string[];
  /** 会话的 Gen UI 输出目录；只在 Desktop 段声明支持 Gen UI 时有。旧元数据没有这个字段。 */
  visualizationDirectory?: string;
  /** 本次运行在 ZCode Desktop 呈现面时为 true，环境块带 Desktop 段。 */
  desktopContext?: boolean;
}

export interface EnvironmentAnnouncement {
  snapshot: EnvironmentSnapshot;
  /** true = 模型已收到完整 `# Environment` 正文（system 首块或整段重发）。 */
  full: boolean;
}

export function environmentSnapshot(
  info: EnvInfo,
  additionalDirectories: readonly string[] = [],
): EnvironmentSnapshot {
  return {
    cwd: info.cwd,
    platform: info.platform,
    shell: info.shell,
    osVersion: info.osVersion,
    isGitRepository: isEnvInfoGitRepository(info),
    additionalWorkingDirectories: [...additionalDirectories],
  };
}

export function parseEnvironmentAnnouncement(
  value: unknown,
): EnvironmentAnnouncement | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { full, snapshot } = value as Record<string, unknown>;
  if (typeof full !== "boolean" || typeof snapshot !== "object" || snapshot === null)
    return undefined;
  const {
    cwd,
    platform,
    shell,
    osVersion,
    isGitRepository,
    additionalWorkingDirectories,
    visualizationDirectory,
    desktopContext,
  } = snapshot as Record<string, unknown>;
  if (
    typeof cwd !== "string" ||
    typeof platform !== "string" ||
    typeof shell !== "string" ||
    typeof osVersion !== "string" ||
    typeof isGitRepository !== "boolean"
  ) {
    return undefined;
  }
  if (
    !Array.isArray(additionalWorkingDirectories) ||
    !additionalWorkingDirectories.every((path) => typeof path === "string")
  ) {
    return undefined;
  }
  if (visualizationDirectory !== undefined && typeof visualizationDirectory !== "string") {
    return undefined;
  }
  if (desktopContext !== undefined && typeof desktopContext !== "boolean") return undefined;
  return {
    full,
    snapshot: {
      cwd,
      platform,
      shell,
      osVersion,
      isGitRepository,
      additionalWorkingDirectories: [...additionalWorkingDirectories],
      ...(visualizationDirectory === undefined ? {} : { visualizationDirectory }),
      ...(desktopContext === undefined ? {} : { desktopContext }),
    },
  };
}

/**
 * 比对已公告快照与当前快照，产出增量公告正文（没有变化返回 null）。
 *
 * `hasFullBlock` 表示模型已经在上下文里收到过完整 `# Environment`；本仓首个请求把它放在
 * system 里，因此首次调用会以 `{full:true}` 记录基线而不重复正文。
 */
export function buildEnvironmentAnnouncement(
  next: EnvironmentSnapshot,
  previous: EnvironmentSnapshot | undefined,
  hasFullBlock: boolean,
): { content: string; environment: EnvironmentAnnouncement } | null {
  // shell 跟随最新设置，新 runtime（冷恢复）可能读到另一个 shell；与目录一样只追加变化行。
  const full =
    !previous ||
    !hasFullBlock ||
    previous.platform !== next.platform ||
    previous.osVersion !== next.osVersion;
  if (full) {
    return {
      content: buildEnvInfoBody(next),
      environment: { full: true, snapshot: next },
    };
  }
  const parts: string[] = [];
  const lines = [ENVIRONMENT_UPDATE_HEADING];
  if (previous.cwd !== next.cwd) {
    lines.push(`- ${WORKING_DIRECTORY_LABEL}: ${next.cwd} (was ${previous.cwd})`);
  }
  if (previous.isGitRepository !== next.isGitRepository) {
    lines.push(
      `- ${IS_GIT_REPOSITORY_LABEL}: ${next.isGitRepository ? YES_LABEL : NO_LABEL} (was ${previous.isGitRepository ? YES_LABEL : NO_LABEL})`,
    );
  }
  // 附加目录会随 Host 项目配置在冷恢复时变化：只列出增量，避免整块重发。
  const before = new Set(previous.additionalWorkingDirectories);
  const after = new Set(next.additionalWorkingDirectories);
  const added = next.additionalWorkingDirectories.filter((path) => !before.has(path));
  const removed = previous.additionalWorkingDirectories.filter((path) => !after.has(path));
  if (added.length > 0) {
    lines.push(`- ${ADDITIONAL_DIRECTORIES_ADDED_LABEL}:`, ...pathLines(added));
  }
  if (removed.length > 0) {
    lines.push(`- ${ADDITIONAL_DIRECTORIES_REMOVED_LABEL}:`, ...pathLines(removed));
  }
  if (previous.visualizationDirectory !== next.visualizationDirectory) {
    const was = previous.visualizationDirectory
      ? ` (was ${previous.visualizationDirectory})`
      : "";
    lines.push(
      `- ${VISUALIZATION_DIRECTORY_LABEL}: ${next.visualizationDirectory ?? "none"}${was}`,
    );
  }
  if (previous.shell !== next.shell) {
    // 旧 Windows 会话的 Shell 可能为空，没有可写的旧值。
    const was = previous.shell ? ` (was ${previous.shell})` : "";
    lines.push(`- ${SHELL_LABEL}: ${next.shell}${was}`);
  }
  if (lines.length > 1) parts.push(lines.join("\n"));
  // Desktop 段按写法比较：换了写法追加整段新写法，离开 Desktop 追加一句不再适用。
  const previousDesktop = desktopContextText(previous);
  const nextDesktop = desktopContextText(next);
  if (previousDesktop !== nextDesktop) {
    parts.push(nextDesktop ?? DESKTOP_CONTEXT_NO_LONGER_APPLIES);
  }
  if (parts.length === 0) return null;
  return {
    content: parts.join("\n\n"),
    environment: { full: false, snapshot: next },
  };
}

/** 环境块里的 Desktop 段：与 system 渲染共用同一份正文（不新写一套措辞）。 */
function desktopContextText(snapshot: EnvironmentSnapshot): string | undefined {
  return snapshot.desktopContext
    ? buildDesktopContextSection(snapshot.visualizationDirectory).content
    : undefined;
}

/** 完整环境正文（不含模型身份）：system 首块与整段重发共用。 */
export function buildEnvInfoBody(
  info: EnvironmentSnapshot,
  model?: Model,
): string {
  const directories = info.additionalWorkingDirectories;
  const lines: string[] = [
    ENVIRONMENT_HEADING,
    "You have been invoked in the following environment:",
    `- ${WORKING_DIRECTORY_LABEL}: ${info.cwd}`,
    // 附加目录此前只进入能力发现，模型看不到目录范围；这里只投影本次运行已解析的路径。
    ...(directories.length > 0
      ? [`- ${ADDITIONAL_DIRECTORIES_LABEL}:`, ...pathLines(directories)]
      : []),
    ...(info.visualizationDirectory
      ? [`- ${VISUALIZATION_DIRECTORY_LABEL}: ${info.visualizationDirectory}`]
      : []),
    `- ${IS_GIT_REPOSITORY_LABEL}: ${info.isGitRepository ? YES_LABEL : NO_LABEL}`,
    `- ${PLATFORM_LABEL}: ${info.platform}`,
    `- ${SHELL_LABEL}: ${info.shell}`,
    `- ${OS_VERSION_LABEL}: ${info.osVersion}`,
    `- ${UNTRUSTED_DOWNLOADS_NOTE}`,
    // 旧环境快照可能携带历史模型字段；渲染只读取本步骤实际执行的 Model。
    ...(model ? [`- You are powered by the model named ${model.providerId}/${model.modelId}.`] : []),
  ];
  const desktop = desktopContextText(info);
  return desktop ? `${lines.join("\n")}\n\n${desktop}` : lines.join("\n");
}

function pathLines(paths: readonly string[]): string[] {
  return paths.map((path) => `  - ${path}`);
}

export function buildEnvInfoSection(
  envInfo: EnvInfo,
  model?: Model,
  additionalDirectories: readonly string[] = [],
): ContextSection {
  const content = buildEnvInfoContent(envInfo, model, additionalDirectories);

  return {
    name: "Environment Info",
    source: "env_info",
    injectionTarget: "system",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

export function buildGitSystemContextSection(envInfo: EnvInfo): ContextSection | null {
  if (!isEnvInfoGitRepository(envInfo)) {
    return null;
  }

  const content = buildGitSystemContextContent(envInfo);

  return {
    name: "System Context",
    source: "system_context",
    injectionTarget: "system",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

function buildEnvInfoContent(
  info: EnvInfo,
  model: Model | undefined,
  additionalDirectories: readonly string[],
): string {
  // system 首块与整段重发（环境公告）共用同一份正文，避免两套措辞各自漂移。
  return buildEnvInfoBody(environmentSnapshot(info, additionalDirectories), model);
}

function buildGitSystemContextContent(info: EnvInfo): string {
  const lines: string[] = [GIT_SYSTEM_CONTEXT_PREFIX];

  if (info.gitBranch) {
    lines.push("", `${CURRENT_BRANCH_LABEL}: ${info.gitBranch}`);
  }
  if (info.gitMainBranch) {
    lines.push("", `${MAIN_BRANCH_LABEL}: ${info.gitMainBranch}`);
  }
  if (info.gitUser) {
    lines.push("", `${GIT_USER_LABEL}: ${info.gitUser}`);
  }

  lines.push("", `${STATUS_LABEL}:\n${formatGitStatus(info)}`);
  lines.push("", `${RECENT_COMMITS_LABEL}:\n${formatRecentCommits(info)}`);

  return lines.join("\n");
}

export function isEnvInfoGitRepository(info: EnvInfo): boolean {
  return (
    info.isGitRepository ??
    (info.gitStatus !== undefined ? info.gitStatus !== "not_repo" : Boolean(info.gitBranch))
  );
}

function formatGitStatus(info: EnvInfo): string {
  if (info.gitStatusLines && info.gitStatusLines.length > 0) {
    return info.gitStatusLines.join("\n");
  }
  if (info.gitStatus === "dirty") {
    return DIRTY_GIT_STATUS;
  }
  if (info.gitStatus === "clean") {
    return CLEAN_GIT_STATUS;
  }
  return UNKNOWN_GIT_STATUS;
}

function formatRecentCommits(info: EnvInfo): string {
  if (info.recentCommits && info.recentCommits.length > 0) {
    return info.recentCommits.join("\n");
  }
  return "";
}
