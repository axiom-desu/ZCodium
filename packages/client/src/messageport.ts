import { safeLogArgs } from "@zcode/shared";
import { MessagePortProtocol, ChannelClient, type RPCOptions } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";
import { isRendererProductionBuild } from "./rendererLoggingEnv.js";

function logMessagePortDebug(message: string): void {
  // 生产构建下 renderer 连接日志不输出，避免窗口启动和重连路径产生同步 console 成本。
  if (isRendererProductionBuild()) {
    return;
  }
  console.log(...safeLogArgs([message]));
}

export interface MessagePortServiceConnection {
  services: IServiceAccessor;
  dispose: (reason?: Error) => void;
}

/** 只在桌面本机 base attachment 打开的附加服务面；远程/手机/Web 不声明。 */
interface MessagePortServiceFeatureOptions {
  /** 数据同步页：设备同步状态 + Provider Provisioning lane（只在本机 Host 注册）。 */
  dataSyncServices?: boolean;
  /** 扩展 host 投影：只在本机 base attachment 注册，手机/Web/远程不创建代理。 */
  localExtensions?: boolean;
  /** 受管 worktree / 远端项目入口 intent：只在本机 base attachment 注册。 */
  localHostServices?: boolean;
}

/**
 * 创建一个带明确生命周期的 MessagePort service connection。
 *
 * scoped remote session 换代时必须同时释放 ChannelClient 和底层 port，
 * 否则旧 attachment 上的挂起 RPC 无法 settle，并会继续占用上层去重状态。
 */
export function createMessagePortServiceConnection(
  port: MessagePort,
  options: RPCOptions & MessagePortServiceFeatureOptions = {},
): MessagePortServiceConnection {
  logMessagePortDebug("[messageport] creating protocol and client...");
  const protocol = new MessagePortProtocol(port);
  const client = new ChannelClient(protocol, options);
  client.onDidInitialize(() => {
    logMessagePortDebug("[messageport] ChannelClient received Initialize from server");
  });
  logMessagePortDebug("[messageport] client created, waiting for Initialize...");

  const services = new RemoteServiceAccess(client, {
    dataSyncServices: options.dataSyncServices,
    localExtensions: options.localExtensions,
    localHostServices: options.localHostServices,
  });
  let disposed = false;
  return {
    services,
    dispose: (reason?: Error) => {
      if (disposed) {
        return;
      }
      disposed = true;
      client.dispose(reason);
      protocol.disconnect();
    },
  };
}

/**
 * 通过 MessagePort 连接服务。
 *
 * Desktop 模式下，utilityProcess（或 main 进程的远程代理）通过 MessagePort
 * 暴露 ChannelServer，renderer 用此函数建立 ChannelClient 连接。
 */
export function connectViaMessagePort(
  port: MessagePort,
  options: RPCOptions & MessagePortServiceFeatureOptions = {},
): IServiceAccessor {
  return createMessagePortServiceConnection(port, options).services;
}
