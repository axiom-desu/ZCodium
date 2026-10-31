import { createConnection } from "node:net";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { ServerLayout } from "../runtime/paths.js";
import { readPersistedStatusDetailed } from "../runtime/statusSnapshot.js";

export class ProxyStdioError extends Error {
  public constructor(
    public readonly code: "daemon-not-ready" | "daemon-connect-failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProxyStdioError";
  }
}

interface ProxyStdioOptions {
  layout: ServerLayout;
  input: Readable;
  output: Writable;
}

export async function runProxyStdio(options: ProxyStdioOptions): Promise<void> {
  const persisted = await readPersistedStatusDetailed(options.layout);
  const status = persisted.status;
  if (
    persisted.state !== "valid" ||
    status?.state !== "ready" ||
    status.port === null ||
    status.port <= 0
  ) {
    throw new ProxyStdioError(
      "daemon-not-ready",
      "ZCode Server daemon is not ready for proxy-stdio",
    );
  }

  const socket = createConnection({ host: "127.0.0.1", port: status.port });
  // stdin 可能在 TCP connect 完成前 abort；必须先监听，否则 PassThrough/stdin 的 error
  // 没有消费者会升级成未处理异常，且 connect 竞态会一直挂着。
  let earlyInputError: Error | undefined;
  let rejectEarly: (error: Error) => void = () => undefined;
  const earlyFailure = new Promise<never>((_resolve, reject) => {
    rejectEarly = reject;
  });
  const onEarlyInputError = (error: Error): void => {
    earlyInputError = error;
    socket.destroy();
    rejectEarly(error);
  };
  options.input.once("error", onEarlyInputError);
  try {
    await Promise.race([
      once(socket, "connect"),
      new Promise<never>((_resolve, reject) => socket.once("error", reject)),
      earlyFailure,
    ]);
  } catch (error) {
    socket.destroy();
    if (earlyInputError) throw earlyInputError;
    throw new ProxyStdioError(
      "daemon-connect-failed",
      "Unable to connect proxy-stdio to the ZCode Server daemon",
      { cause: error },
    );
  } finally {
    options.input.off("error", onEarlyInputError);
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      socket.off("error", fail);
      options.input.off("error", fail);
      options.output.off("error", fail);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (options.output.writableNeedDrain) {
        options.output.once("drain", resolve);
      } else {
        resolve();
      }
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    socket.once("close", finish);
    socket.once("error", fail);
    options.input.once("error", fail);
    options.output.once("error", fail);
    // stdout 必须保持纯字节通道；错误只由 CLI 写 stderr，桥内不注入任何 framing。
    options.input.pipe(socket);
    socket.pipe(options.output, { end: false });
  });
}
