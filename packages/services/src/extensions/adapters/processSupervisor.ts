/**
 * Host 侧进程端口：Main 只做生命周期，Host 不直接 spawn 扩展进程。
 * 每个 `(window, pluginId)` 独立 start/stop，撤销只停目标插件。
 */
export interface ExtensionsProcessSupervisor {
  start(input: {
    generation: number;
    workspaceIdentity: string;
    endpoint: string;
    token: string;
    /** 单个插件自己的目录；worker 不再扫描父目录。 */
    pluginDir: string;
    pluginId: string;
  }): Promise<{ pid: number }>;
  /** 停止该代际的全部插件进程。 */
  stop(generation: number): Promise<void>;
  /** 只停止某个插件；撤销时不能误停同窗口其他插件。 */
  stopPlugin(generation: number, pluginId: string): Promise<void>;
}

const START_TIMEOUT_MS = 10_000;

export async function startExtensionWithTimeout(
  supervisor: ExtensionsProcessSupervisor,
  input: Parameters<ExtensionsProcessSupervisor["start"]>[0],
): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Extension host did not become ready in time.")),
      START_TIMEOUT_MS,
    );
  });
  try {
    const started = await Promise.race([supervisor.start(input), timeout]);
    return started.pid;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
