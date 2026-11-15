import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  EXTENSION_HOST_ENV,
  extensionHostBootstrapFrameSchema,
  extensionHostMainMessageSchema,
  extensionHostProcessMessageSchema,
  validateExtensionManifest,
  type ExtensionHostBootstrapFrame,
  type ExtensionHostProcessMessage,
  type ExtensionManifest,
} from "@zcode/shared/extension-host";
import {
  createExtensionContext,
  createExtensionHostClient,
  type ExtensionActivate,
} from "@zcode/shared/extension-host/sdk";

/**
 * 扩展宿主进程（由 Desktop Main supervisor 拉起）。
 *
 * 每个进程只服务 env 指定的一个插件：只读取该目录的 `extension.json`，校验 manifest.id 与 env
 * 一致后加载 `manifest.main`；不再扫描发现目录，也不持有其他插件的 token。
 *
 * 凭据不在环境变量里：supervisor 通过继承的私有 stdin 先写一条一次性 bootstrap 帧，
 * 本进程读取并消耗后才加载插件；此后同一管道只承载 shutdown。token 只留在内存并交给 SDK，
 * 不写入 ready/log/error/stdout。激活失败必须经严格 error 帧上报并以非零码退出，
 * 不能让 supervisor/Host 把没有加载任何东西的进程显示成 ready。
 */
interface LoadedExtension {
  manifest: ExtensionManifest;
  dispose?: () => void;
}

const loaded: LoadedExtension[] = [];
let shuttingDown = false;
let stdinBuffer = "";
let bootstrapFrame: ExtensionHostBootstrapFrame | null = null;
let bootstrapWaiter: {
  resolve(frame: ExtensionHostBootstrapFrame): void;
  reject(error: Error): void;
} | null = null;

function send(message: ExtensionHostProcessMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function requestShutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const extension of loaded) {
    try {
      extension.dispose?.();
    } catch {
      // 单个扩展 dispose 失败不能阻止进程退出。
    }
  }
  process.exit(0);
}

function resolveBootstrap(frame: ExtensionHostBootstrapFrame): void {
  bootstrapFrame = frame;
  const waiter = bootstrapWaiter;
  bootstrapWaiter = null;
  waiter?.resolve(frame);
}

function failBootstrap(message: string): void {
  const waiter = bootstrapWaiter;
  bootstrapWaiter = null;
  waiter?.reject(new Error(message));
}

function handleStdinLine(line: string): void {
  if (bootstrapFrame === null) {
    // 第一帧必须是 bootstrap；invalid JSON 或错误帧都按启动失败处理。
    if (!bootstrapWaiter) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      failBootstrap("Invalid extension bootstrap frame.");
      return;
    }
    const frame = extensionHostBootstrapFrameSchema.safeParse(parsed);
    if (!frame.success) {
      failBootstrap("Invalid extension bootstrap frame.");
      return;
    }
    resolveBootstrap(frame.data);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  const message = extensionHostMainMessageSchema.safeParse(parsed);
  if (message.success && message.data.type === "shutdown") requestShutdown();
}

function handleStdinData(chunk: string): void {
  stdinBuffer += chunk;
  let index = stdinBuffer.indexOf("\n");
  while (index >= 0) {
    const line = stdinBuffer.slice(0, index).trim();
    stdinBuffer = stdinBuffer.slice(index + 1);
    if (line) handleStdinLine(line);
    index = stdinBuffer.indexOf("\n");
  }
}

function awaitBootstrap(): Promise<ExtensionHostBootstrapFrame> {
  if (bootstrapFrame) return Promise.resolve(bootstrapFrame);
  return new Promise((resolve, reject) => {
    bootstrapWaiter = { resolve, reject };
  });
}

process.on("SIGTERM", requestShutdown);
process.on("SIGINT", requestShutdown);
process.stdin.setEncoding("utf8");
process.stdin.on("data", handleStdinData);
process.stdin.on("end", () => {
  if (bootstrapFrame === null) failBootstrap("Extension host stdin closed before bootstrap.");
  else requestShutdown();
});

async function main(): Promise<void> {
  const pluginDir = required(EXTENSION_HOST_ENV.pluginDir);
  const pluginId = required(EXTENSION_HOST_ENV.pluginId);
  const endpoint = required(EXTENSION_HOST_ENV.endpoint);
  const generation = Number(required(EXTENSION_HOST_ENV.generation));
  const workspaceIdentity = required(EXTENSION_HOST_ENV.workspaceIdentity);
  if (!Number.isInteger(generation) || generation <= 0) throw new Error("Invalid generation.");

  // 一次性凭据帧：读取即消耗，之后不会再次接受 bootstrap。
  const token = (await awaitBootstrap()).token;

  const raw = await readFile(join(pluginDir, "extension.json"), "utf8");
  const validation = validateExtensionManifest(JSON.parse(raw));
  if (!validation.ok) throw new Error(`Invalid extension manifest: ${validation.code}`);
  const manifest = validation.manifest;
  if (manifest.id !== pluginId) {
    throw new Error("Extension manifest identity does not match the assigned plugin.");
  }

  const client = createExtensionHostClient({
    endpoint,
    token,
    generation,
    workspaceIdentity,
    pluginId: manifest.id,
  });
  const context = createExtensionContext(client, manifest.id);
  try {
    const module = (await import(
      `${pathToFileURL(join(pluginDir, manifest.main)).href}?generation=${generation}`
    )) as { default?: unknown; activate?: unknown };
    const activate = resolveActivate(module);
    const dispose = await activate(context);
    loaded.push({ manifest, ...(typeof dispose === "function" ? { dispose } : {}) });
    if (manifest.slots.length > 0) await client.contribute(manifest.slots);
  } catch (error) {
    client.dispose();
    // 激活失败必须让 supervisor 拒绝 start，而不是继续发 ready。
    throw error;
  }

  send({ type: "ready", generation, pluginId: manifest.id });
}

function resolveActivate(module: { default?: unknown; activate?: unknown }): ExtensionActivate {
  const candidate =
    typeof module.default === "object" && module.default !== null
      ? (module.default as { activate?: unknown }).activate
      : module.activate;
  if (typeof candidate !== "function") throw new Error("Extension has no activate export.");
  return candidate as ExtensionActivate;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment: ${name}`);
  return value;
}

main().catch((error: unknown) => {
  // 错误帧有界且不回显凭据；消息过长时截断，保证 supervisor 一定能收到失败信号。
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  const parsed = extensionHostProcessMessageSchema.safeParse({ type: "error", message });
  if (!parsed.success) {
    process.exit(1);
    return;
  }
  // 先把错误帧写进管道再退出；'exit' 可能早于 stdout 到达，给出有界宽限。
  process.stdout.write(`${JSON.stringify(parsed.data)}\n`, () => process.exit(1));
  setTimeout(() => process.exit(1), 250);
});
