import { randomUUID } from "node:crypto";
import { createServiceLogger } from "@zcode/services/node";
import { Emitter, VSBuffer, SocketProtocol, ChannelServer, type ISocket } from "@zcode/rpc";
import {
  IZCodeAgentService,
  createZCodeAgentConnectionScope,
  type ServiceCollection,
} from "@zcode/services";

const rpcLog = createServiceLogger("server-stdio:rpc");

/**
 * Wrap process.stdin/stdout as an ISocket for RPC communication.
 * In stdio mode, stdout is reserved exclusively for RPC data.
 * All logging must go through stderr.
 */
export function wrapStdio(): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  process.stdin.on("data", (chunk: Buffer) => {
    onData.fire(VSBuffer.wrap(new Uint8Array(chunk)));
  });
  process.stdin.on("end", () => {
    onClose.fire();
    onEnd.fire();
  });
  process.stdin.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      process.stdout.write(Buffer.from(buffer.buffer));
    },
    end() {
      process.stdout.end();
    },
    drain() {
      return new Promise<void>((resolve) => {
        if (process.stdout.writableNeedDrain) {
          process.stdout.once("drain", resolve);
        } else {
          resolve();
        }
      });
    },
    dispose() {
      process.stdin.destroy();
    },
  };
}

export function createStdioServer(services: ServiceCollection) {
  const socket = wrapStdio();
  const protocol = new SocketProtocol(socket);
  const channelServer = new ChannelServer(protocol, "stdio", undefined, undefined, undefined, {
    logger: (message, ...args) => rpcLog.warn(undefined, message, ...args),
  });
  const agentService = services.getOptional(IZCodeAgentService);
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(agentService, {
        connectionId: `server-stdio-${randomUUID()}`,
        clientMode: "desktop-continuous",
        role: "trusted-host-relay",
      })
    : undefined;
  services.exposeOnChannelServer(
    channelServer,
    connectionScope
      ? new Map([[IZCodeAgentService.channelName, connectionScope.service]])
      : new Map(),
  );
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopPromise) {
      return stopPromise;
    }

    // 先同步摘掉 protocol listener，保证从这一刻起不再接收新的 service RPC；
    // connection scope 的异步退订完成后再关闭底层 stdio。
    channelServer.dispose();
    stopPromise = (async () => {
      try {
        await connectionScope?.dispose();
      } finally {
        socket.dispose();
      }
    })();
    return stopPromise;
  };
  socket.onClose(() => {
    void stop();
  });
  return { stop };
}
