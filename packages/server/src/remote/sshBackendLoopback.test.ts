import { generateKeyPair } from "node:crypto";
import { once } from "node:events";
import { promisify } from "node:util";
import { Client, Server as SSHServer } from "ssh2";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDataBaseDir } from "@zcode/services/node";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SSHBackend } from "./ssh-backend.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "p2-ssh-loopback-"));
  setDataBaseDir(directory);
  vi.stubEnv("HOME", directory);
  vi.stubEnv("USERPROFILE", directory);
  vi.stubEnv("SSH_AUTH_SOCK", "");
  vi.stubEnv("XDG_CONFIG_HOME", join(directory, "config"));
  vi.stubEnv("XDG_DATA_HOME", join(directory, "data"));
});
afterEach(async () => {
  setDataBaseDir(null);
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

type SSHInternals = { client: Client; connectingPromise: Promise<void> | null };

it("真实 banner 后 FIN 无 error/dispose：并发 waiter 立即失败且可单飞重试", async () => {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", () => {
      // 收到 banner 后再等客户端 KEX，确保 ssh2 不走“未收到 header”的 error 分支。
      socket.once("data", () => socket.end());
      socket.write("SSH-2.0-p2-loopback-fixture\r\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback address unavailable");
  const backend = new SSHBackend({ host: "127.0.0.1", port: address.port, username: "fixture" });
  const internals = backend as unknown as SSHInternals;
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const failures: unknown[] = [];
      const pending = [backend.exec("never executed"), backend.exec("also never executed")].map(
        (promise) => promise.catch((error: unknown) => failures.push(error)),
      );
      const client = internals.client;
      const errors: unknown[] = [];
      client.on("error", (error) => errors.push(error));
      await once(client, "close");
      // 只观察事件后的 microtask，不以超时或 dispose 驱动生产代码 settle。
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(errors).toEqual([]);
      expect(connections).toBe(attempt);
      expect(failures).toHaveLength(2);
      for (const failure of failures)
        expect(failure).toMatchObject({ message: expect.stringContaining("就绪") });
      await Promise.all(pending);
      expect(internals.connectingPromise).toBeNull();
    }
  } finally {
    backend.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 2_000);

it("真实旧 socket end → 后继 flight → 旧 close，不破坏后继 ready/exec", async () => {
  const { privateKey } = await promisify(generateKeyPair)("rsa", { modulusLength: 2048 });
  const sshServer = new SSHServer({
    hostKeys: [privateKey.export({ type: "pkcs1", format: "pem" })],
  });
  sshServer.on("connection", (client) => {
    client.on("error", () => {});
    client.on("authentication", (context) => context.accept());
    client.on("session", (accept) => {
      accept().on("exec", (acceptExec) => {
        const stream = acceptExec();
        stream.write("fixture output");
        stream.exit(0);
        stream.end();
      });
    });
  });
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    if (++connections > 1) {
      sshServer.injectSocket(socket);
      return;
    }
    socket.once("data", () => {
      socket.once("data", () => socket.end());
      socket.write("SSH-2.0-p2-loopback-fixture\r\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback address unavailable");
  const backend = new SSHBackend({ host: "127.0.0.1", port: address.port, username: "fixture" });
  const internals = backend as unknown as SSHInternals;
  const disconnects = vi.fn();
  backend.onDidDisconnect(disconnects);
  try {
    const order: string[] = [];
    const first = backend.exec("never executed").catch((error: unknown) => error);
    const oldClient = internals.client;
    const retry = first.then(() => {
      order.push("retry");
      const pending = backend.exec("fixture");
      void pending.catch(() => {});
      expect(internals.client).not.toBe(oldClient);
      return pending;
    });
    // 即便旧 close 迟于新 connect，ssh2 的旧 callbacks/channel cleanup 也不得触及后继。
    void retry.catch(() => {});
    const closed = once(oldClient, "close");
    oldClient.once("close", () => order.push("old-close"));
    await closed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(["retry", "old-close"]);
    const stream = await retry;
    const chunks: Buffer[] = [];
    stream.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    await new Promise<void>((resolve) => stream.onClose(() => resolve()));
    expect(Buffer.concat(chunks).toString()).toBe("fixture output");
    expect(connections).toBe(2);
    expect(disconnects).not.toHaveBeenCalled();
  } finally {
    backend.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 3_000);

it("真实 loopback banner 后 dispose 立即结束在途 connect，不依赖服务端 ready/error", async () => {
  const sockets = new Set<Socket>();
  let acceptHandshake: () => void = () => {};
  const handshaking = new Promise<void>((resolve) => {
    acceptHandshake = resolve;
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    // 仅交换 banner 并接收客户端 KEX；不提供主机密钥，不认证、不触发 known_hosts 文件 IO。
    socket.once("data", () => {
      socket.once("data", () => acceptHandshake());
      socket.write("SSH-2.0-p2-loopback-fixture\r\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback address unavailable");
  const backend = new SSHBackend({ host: "127.0.0.1", port: address.port, username: "fixture" });
  try {
    const pending = backend.exec("fixture command is never executed");
    const rejected = expect(pending).rejects.toThrow("已释放");
    await handshaking;
    backend.dispose();
    await rejected;
    await expect(backend.exec("must not reconnect")).rejects.toThrow("已释放");
  } finally {
    backend.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 2_000);
