import { Duplex } from "node:stream";
import {
  SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
  SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
  ZCODE_COMPATIBILITY_MANIFEST,
  evaluateSourceServerCompatibility,
  type CompatibilityManifest,
  type RemoteTarget,
  type ServerRemoteInfo,
} from "@zcode/shared";
import {
  SourceServerTransportOperationError,
  type ServerReleaseAsset,
  type SourceServerIngressInfo,
  type SourceServerProbeResult,
  type SourceServerTransportAdapter,
  type TransportContext,
} from "@zcode/server/source-server/transportAdapter.js";

export interface ConnectSourceServerTransportOptions {
  adapter: Pick<
    SourceServerTransportAdapter,
    "probe" | "installOrUpdate" | "ensureDaemon" | "openChannel"
  >;
  target: RemoteTarget;
  context?: TransportContext;
  /** 控制端兼容清单；测试显式注入，生产走构建注入的默认值。 */
  compatibilityManifest?: CompatibilityManifest;
  /** 用户在向导确认后才允许上传 archive / 执行安装或升级命令。 */
  confirmSourceServerInstall?: boolean;
  /** 已确认的安装/升级制品；缺失时即使已确认也只能返回 typed install-required。 */
  release?: ServerReleaseAsset;
  forceUpdate?: boolean;
}

export interface ConnectSourceServerTransportResult {
  probe: SourceServerProbeResult;
  ingress: SourceServerIngressInfo;
  /** 首次调用才真正创建 proxy-stdio/直连通道；调用方负责关闭返回的 Duplex。 */
  openDuplex: () => Promise<Duplex>;
}

function readCompatibilityManifest(): CompatibilityManifest {
  return ZCODE_COMPATIBILITY_MANIFEST;
}

/**
 * 未确认安装/升级时的 typed 错误：调用方据此回到向导，不发生任何上传或安装命令。
 */
export class SourceServerInstallRequiredError extends SourceServerTransportOperationError {
  public constructor(message = "Source Server install is required") {
    super(message, SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE, false);
    this.name = "SourceServerInstallRequiredError";
  }
}

export class SourceServerUpgradeRequiredError extends SourceServerTransportOperationError {
  public readonly upgradeTarget: "controller" | "server";

  public constructor(message: string, upgradeTarget: "controller" | "server") {
    super(message, SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE, false);
    this.name = "SourceServerUpgradeRequiredError";
    this.upgradeTarget = upgradeTarget;
  }
}

/**
 * 握手后的兼容判定：缺少 compatibility 清单按“旧 Server”处理，只能升级远端。
 * 判定规则本身由 shared 保持严格，不在此处放宽最小兼容版本。
 */
export function assertSourceServerHandshakeCompatible(
  manifest: CompatibilityManifest,
  serverInfo: Pick<ServerRemoteInfo, "version" | "compatibility">,
): ReturnType<typeof evaluateSourceServerCompatibility> {
  if (!serverInfo.compatibility) {
    throw new SourceServerUpgradeRequiredError(
      `Source Server ${serverInfo.version} does not report a compatibility manifest`,
      "server",
    );
  }
  const result = evaluateSourceServerCompatibility(manifest, serverInfo.compatibility);
  if (!result.compatible) {
    throw new SourceServerUpgradeRequiredError(
      `Source Server ${result.olderVersion} is older than required ${result.requiredMinimumVersion} (upgrade ${result.upgradeTarget ?? "server"})`,
      result.upgradeTarget ?? "server",
    );
  }
  return result;
}

/**
 * R3 连接前置流程（纯编排，不含 profile/队列状态）：
 * probe → 兼容/安装 gating → ensureDaemon → 返回单通道工厂。
 *
 * 未确认安装时 probe 之后立即失败：零上传、零安装/升级命令。
 */
export async function connectSourceServerTransport(
  options: ConnectSourceServerTransportOptions,
): Promise<ConnectSourceServerTransportResult> {
  const context = options.context ?? {};
  const manifest = options.compatibilityManifest ?? readCompatibilityManifest();
  const confirmInstall = options.confirmSourceServerInstall === true;
  const probe = await options.adapter.probe(options.target, context);

  let needsInstall = !probe.installed;
  let needsUpgrade = false;
  if (probe.installed && probe.installedVersion) {
    const result = evaluateSourceServerCompatibility(manifest, {
      schemaVersion: 1,
      productVersion: probe.installedVersion,
      // 探测阶段拿不到对端 min 清单；版本比较只用于判断“是否需要升级”，
      // 真正的兼容结论仍由握手后的 compatibility 判定给出。
      minCompatibleVersion: probe.installedVersion,
    });
    needsUpgrade = !result.compatible && result.newerEndpoint === "controller";
  }

  let installedOrUpdated = false;
  if (needsInstall || needsUpgrade) {
    if (!confirmInstall) {
      throw needsInstall
        ? new SourceServerInstallRequiredError()
        : new SourceServerUpgradeRequiredError(
            `Source Server ${probe.installedVersion ?? "unknown"} requires an authorized upgrade`,
            "server",
          );
    }
    if (!options.release) {
      // 已确认但制品未解析：仍然零上传，返回同一 typed 错误供上层显示“需要安装/更新”。
      throw needsInstall
        ? new SourceServerInstallRequiredError("Source Server release is unavailable")
        : new SourceServerUpgradeRequiredError(
            "Source Server upgrade release is unavailable",
            "server",
          );
    }
    const installOptions = options.forceUpdate ? { force: true } : {};
    await options.adapter.installOrUpdate(options.target, options.release, context, installOptions);
    needsInstall = false;
    needsUpgrade = false;
    installedOrUpdated = true;
  }

  // 安装/升级后 daemon 状态必然换代：只能重新启动，不能复用旧的 ready 端口。
  const observedStatus = installedOrUpdated ? undefined : probe.daemonStatus;
  const ingress = await options.adapter.ensureDaemon(
    options.target,
    context,
    observedStatus ? { observedStatus } : {},
  );

  let duplex: Duplex | undefined;
  return {
    probe,
    ingress,
    async openDuplex() {
      if (duplex) {
        throw new Error("Source Server transport channel was already opened");
      }
      duplex = await options.adapter.openChannel(options.target, ingress, context);
      return duplex;
    },
  };
}
