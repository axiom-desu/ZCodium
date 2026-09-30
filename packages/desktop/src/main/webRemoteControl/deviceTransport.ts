import type { WebRemoteControlAppPayload, WebRemoteControlTransportState } from "@zcode/shared";
import { LanRemoteControlEndpoint } from "./lanEndpoint.js";
import type { WebRemoteControlLogger } from "./logger.js";

/**
 * 设备传输抽象：桌面运行时不感知端点形态。
 * - lan：桌面自身端点（默认，同网可达）；
 * - custom：用户自备隧道 / 自托管 relay（P4，按同一接口实现 WS 客户端）。
 *
 * 传输层只负责鉴权、配对、心跳与转发（见 spec），不持有业务状态。
 */

export interface WebRemoteControlDeviceTransportEvents {
  onStateChange(state: WebRemoteControlTransportState): void;
  onPayload(payload: WebRemoteControlAppPayload): void;
  onRegisteredAuth(auth: { deviceSid: string; passHash: string }): void;
  onError(error: Error): void;
  onInvalidPersistedAuth(): Promise<void>;
}

export interface WebRemoteControlDeviceTransport {
  start(): Promise<void>;
  sendPayload(payload: WebRemoteControlAppPayload): boolean;
  dispose(): void;
}

export interface LanDeviceTransportOptions {
  logger: WebRemoteControlLogger;
  deviceMid: string;
  deviceName: string;
  appVersion: string;
  events: WebRemoteControlDeviceTransportEvents;
  /** 移动端 payload 的目的地（带 deviceSid 供 manager 路由到对应窗口）。 */
  handleMobilePayload(deviceSid: string, payload: WebRemoteControlAppPayload): void;
  maxPhysicalFrameBytes: number;
  port?: number;
  auth:
    | { mode: "register"; passHash: string }
    | { mode: "persisted"; deviceSid: string; passHash: string };
  /** manager 持有的共享端点；已启动时不会重复 bind。 */
  endpoint: LanRemoteControlEndpoint;
}

/** LAN 传输：把端点能力适配成 DeviceTransport；start 后即可生成 QR。 */
export function createLanDeviceTransport(
  options: LanDeviceTransportOptions,
): WebRemoteControlDeviceTransport & { baseUrls(): string[] } {
  const endpoint = options.endpoint;
  let device: ReturnType<LanRemoteControlEndpoint["registerDevice"]> | undefined;
  let disposed = false;
  const deviceSid = options.auth.mode === "persisted" ? options.auth.deviceSid : "pending";

  return {
    baseUrls: () => endpoint.baseUrls,
    async start() {
      if (!endpoint.isRunning) {
        await endpoint.start();
      }
      device = endpoint.registerDevice(options.auth, {
        onStateChange: (state) => {
          if (disposed) return;
          options.events.onStateChange(
            state === "error" ? "error" : (state as WebRemoteControlTransportState),
          );
        },
        onPayload: (payload) => {
          if (!disposed) options.events.onPayload(payload);
        },
        onRegisteredAuth: (auth) => {
          if (!disposed) options.events.onRegisteredAuth(auth);
        },
        onError: (error) => {
          if (!disposed) options.events.onError(error);
        },
        onInvalidPersistedAuth: () => {
          if (!disposed) void options.events.onInvalidPersistedAuth();
        },
        onMobileDisconnected: () => {
          if (disposed) return;
          // 端点把「手机断开」上报为 waiting_terminal；宽限期由运行时决定。
          options.events.onStateChange("waiting_terminal");
        },
      });
    },
    sendPayload(payload) {
      if (disposed || !device) return false;
      return endpoint.deliverToMobile(device.deviceSid, payload);
    },
    dispose() {
      disposed = true;
      device?.dispose();
      endpoint.releaseDevice(deviceSid);
    },
  };
}
