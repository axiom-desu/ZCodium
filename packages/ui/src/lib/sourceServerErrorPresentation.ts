import {
  SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE,
  SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
  SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
  SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
} from "@zcode/shared";

interface SourceServerErrorPresentation {
  titleId: string;
  reasonId: string;
  retryable: boolean;
}

/**
 * Source 错误只映射到既有错误分类与恢复提示，不新增 timeout 兜底、网络探测或 HTTP 轮询。
 * 未知错误回退到通用文案，原始信息仍由调用方在 details 中展示。
 */
const PRESENTATIONS: Record<string, SourceServerErrorPresentation> = {
  [SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE]: {
    titleId: "source.error.installRequired.title",
    reasonId: "source.error.installRequired.reason",
    retryable: true,
  },
  [SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE]: {
    titleId: "source.error.upgradeRequired.title",
    reasonId: "source.error.upgradeRequired.reason",
    retryable: true,
  },
  [SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE]: {
    titleId: "source.error.runningTasks.title",
    reasonId: "source.error.runningTasks.reason",
    retryable: true,
  },
  [SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE]: {
    titleId: "source.error.identityChange.title",
    reasonId: "source.error.identityChange.reason",
    retryable: true,
  },
  "remote-target-changed": {
    titleId: "source.error.targetChanged.title",
    reasonId: "source.error.targetChanged.reason",
    retryable: true,
  },
  "credentials-required": {
    titleId: "source.error.credentialsRequired.title",
    reasonId: "source.error.credentialsRequired.reason",
    retryable: true,
  },
  "remote-authentication-failed": {
    titleId: "source.error.authenticationFailed.title",
    reasonId: "source.error.authenticationFailed.reason",
    retryable: true,
  },
  "remote-host-unreachable": {
    titleId: "source.error.hostUnreachable.title",
    reasonId: "source.error.hostUnreachable.reason",
    retryable: true,
  },
  "remote-connection-canceled": {
    titleId: "source.error.canceled.title",
    reasonId: "source.error.canceled.reason",
    retryable: true,
  },
};

const GENERIC: SourceServerErrorPresentation = {
  titleId: "source.error.generic.title",
  reasonId: "source.error.generic.reason",
  retryable: false,
};

export function resolveSourceServerErrorPresentation(
  code: string | undefined,
): SourceServerErrorPresentation {
  return (code ? PRESENTATIONS[code] : undefined) ?? GENERIC;
}
