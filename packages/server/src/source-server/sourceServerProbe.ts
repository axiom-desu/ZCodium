import {
  normalizeRemoteArch,
  normalizeRemotePlatform,
  resolveRemotePlatform,
} from "@zcode/server/remote/detectEnv.js";
import type { IRemoteBackend } from "@zcode/server/remote/backend.js";
import { assertSupportedRemoteEnvironment } from "@zcode/server/remote/remotePlatformSupport.js";
import {
  collectCommand,
  readLastJsonLine,
  readUniqueVersion,
  throwIfAborted,
} from "@zcode/server/source-server/sourceServerTransportRuntime.js";
import {
  SOURCE_SERVER_DEFAULT_ROOT_READ_PATH,
  sourceServerBinShell,
  sourceServerFileReadPath,
  sourceServerRootShell,
  sourceServerRunFileReadPath,
} from "@zcode/server/source-server/sourceServerLayout.js";
import type {
  SourceServerProbeOptions,
  SourceServerProbeResult,
  TransportContext,
} from "@zcode/server/source-server/transportAdapter.js";

const SOURCE_SERVER_PROBE_MARKER_PREFIX = "__ZCODE_PROBE_";

function buildSourceServerProbeCommand(
  includeReleaseIdentity: boolean,
  rootReadPath: string,
): string {
  const rootShell = sourceServerRootShell(rootReadPath);
  const binShell = sourceServerBinShell(rootReadPath);
  const statusShell = sourceServerRunFileReadPath("status.json", rootReadPath);
  const currentShell = sourceServerFileReadPath("current.json", rootReadPath);
  return [
    "set +e",
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}PLATFORM__\\n'`,
    "uname -s",
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}ARCH__\\n'`,
    "uname -m",
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}ROOT__\\n'`,
    `printf '%s\\n' ${rootShell}`,
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}KERNEL__\\n'`,
    "if [ -r /proc/sys/kernel/ostype ]; then cat /proc/sys/kernel/ostype; else printf '\\n'; fi",
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}LIBC__\\n'`,
    // musl、macOS 或缺 getconf 时只留空段；set +e 下不影响 probe 退出码。
    "getconf GNU_LIBC_VERSION 2>/dev/null",
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}INSTALLED__\\n'`,
    `if [ -f ${binShell} ]; then printf '1\\n'; else printf '0\\n'; fi`,
    ...(includeReleaseIdentity
      ? [
          `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}RELEASE__\\n'`,
          `if [ -r ${currentShell} ]; then cat ${currentShell}; fi`,
        ]
      : []),
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}VERSION__\\n'`,
    `if [ -r ${currentShell} ]; then sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' ${currentShell} | head -n 1; fi`,
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}STATUS__\\n'`,
    // Bug 原因：每次 probe 启动两次完整 Server CLI，冷缓存时仅版本/状态读取就会耗尽
    // 10 秒启动预算。current/status 是 CLI 自身的权威持久化文件；status 仅在 PID 仍存活时复用。
    `if [ -r ${statusShell} ]; then status_pid=$(sed -n 's/^[[:space:]]*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' ${statusShell} | head -n 1); if [ -n "$status_pid" ] && kill -0 "$status_pid" 2>/dev/null; then tr -d '\\r\\n' < ${statusShell}; printf '\\n'; fi; fi`,
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}END__\\n'`,
  ].join("; ");
}

function readSourceServerProbeSections(output: string): Map<string, string> {
  const parts = output.split(/__ZCODE_PROBE_([A-Z]+)__\r?\n/gu);
  const sections = new Map<string, string>();
  for (let index = 1; index + 1 < parts.length; index += 2) {
    sections.set(parts[index]!, parts[index + 1]!.trim());
  }
  return sections;
}

/** 远端环境检查本身的失败；只有它归入预检失败，建立连接或执行命令的传输失败不借探测阶段兜底。 */
export class SourceServerProbeEnvironmentError extends Error {
  public override readonly name = "SourceServerProbeEnvironmentError";
}

// archive 内置官方 Node 构建的动态链接下限，随 Node 大版本同步。
const SOURCE_SERVER_MIN_GLIBC_VERSION = [2, 28] as const;

function assertSupportedGlibc(platform: string, libcText: string): void {
  if (platform !== "linux") return;
  // 读不到版本（musl、缺 getconf、输出无法识别）时无法判定，保持原安装链，不凭猜测拒绝。
  const match = /^glibc\s+(\d+)\.(\d+)/iu.exec(libcText);
  if (!match) return;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const [minMajor, minMinor] = SOURCE_SERVER_MIN_GLIBC_VERSION;
  if (major > minMajor || (major === minMajor && minor >= minMinor)) return;
  const required = SOURCE_SERVER_MIN_GLIBC_VERSION.join(".");
  throw new SourceServerProbeEnvironmentError(
    `Remote glibc ${major}.${minor} is older than glibc ${required} required by ZCode Source Server.`,
  );
}

/**
 * 单次远端只读 probe：环境、安装状态、版本与 daemon status 一次取回。
 * 三种 backend（SSH/WSL/Docker）共用同一 POSIX 片段，不再串行发起多次 channel。
 */
export async function probeSourceServer(
  backend: IRemoteBackend,
  context: TransportContext,
  options: SourceServerProbeOptions,
): Promise<SourceServerProbeResult> {
  throwIfAborted(context.signal);
  const rootReadPath = options.rootReadPath ?? SOURCE_SERVER_DEFAULT_ROOT_READ_PATH;
  const result = await collectCommand(
    await backend.exec(
      buildSourceServerProbeCommand(options.includeReleaseIdentity === true, rootReadPath),
    ),
  );
  if (result.exitCode !== 0) {
    throw new SourceServerProbeEnvironmentError(
      result.stderr.trim() || "Source Server environment probe failed",
    );
  }
  const sections = readSourceServerProbeSections(result.stdout);
  const reportedPlatform = sections.get("PLATFORM") ?? "";
  const kernelOstype = sections.get("KERNEL") ?? "";
  const environment = {
    platform: resolveRemotePlatform(normalizeRemotePlatform(reportedPlatform), kernelOstype),
    arch: normalizeRemoteArch(sections.get("ARCH") ?? ""),
    ...(sections.get("ROOT") ? { installPath: sections.get("ROOT") } : {}),
  };
  try {
    assertSupportedRemoteEnvironment(environment);
  } catch (error) {
    throw new SourceServerProbeEnvironmentError(
      error instanceof Error ? error.message : String(error),
    );
  }
  assertSupportedGlibc(environment.platform, sections.get("LIBC") ?? "");
  const installed = sections.get("INSTALLED") === "1";
  if (!installed) return { ...environment, installed: false };

  let installedArchiveSha256: string | undefined;
  const releaseText = sections.get("RELEASE");
  if (releaseText) {
    try {
      const current = JSON.parse(releaseText) as { archiveSha256?: unknown };
      if (
        typeof current.archiveSha256 === "string" &&
        /^[a-f0-9]{64}$/iu.test(current.archiveSha256)
      ) {
        installedArchiveSha256 = current.archiveSha256.toLowerCase();
      }
    } catch (error) {
      // 同 version 的旧开发安装可能没有 archive 身份；缺失必须投影为未知。
      context.onLog?.({
        phase: "probe",
        message: `Source Server release identity is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const versionText = sections.get("VERSION") ?? "";
  const statusText = sections.get("STATUS") ?? "";
  let installedVersion: string | undefined;
  let daemonStatus: SourceServerProbeResult["daemonStatus"];
  try {
    if (versionText) installedVersion = readUniqueVersion(versionText);
  } catch {
    installedVersion = undefined;
  }
  try {
    if (statusText) daemonStatus = readLastJsonLine(statusText) as typeof daemonStatus;
  } catch {
    daemonStatus = undefined;
  }
  return {
    ...environment,
    installed: true,
    ...(installedArchiveSha256 ? { installedArchiveSha256 } : {}),
    ...(installedVersion ? { installedVersion } : {}),
    ...(daemonStatus ? { daemonStatus } : {}),
  };
}
