import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export type CliRuntime = "ts" | "zcode-cli-rust";
export interface CliPlan {
  runtime: CliRuntime;
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function consumeTopLevelCli(argv: string[]): { isCli: boolean; argv: string[] } {
  if (argv[0] !== "--cli") return { isCli: false, argv };
  return { isCli: true, argv: argv.slice(1) };
}

export function getDesktopUserArgv(argv: string[], defaultApp: boolean): string[] {
  // Electron 开发态把 appPath 放在用户参数前；先移除它，避免误判路由标记的位置。
  return defaultApp ? argv.slice(1) : argv;
}

export function resolveCliPlan(options: {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  productFlavor: "production" | "preview";
  resourcesPath?: string;
  bootstrapDir: string;
}): CliPlan {
  const { argv, cwd, env, platform, isPackaged, productFlavor, bootstrapDir } = options;
  const runtimeValue = env.ZCODE_AGENT_SERVER_RUNTIME?.trim().toLowerCase();
  const runtime: CliRuntime = runtimeValue
    ? runtimeValue === "ts" || runtimeValue === "zcode-cli-rust"
      ? runtimeValue
      : fail(`未知 ZCODE_AGENT_SERVER_RUNTIME: ${runtimeValue}`)
    : isPackaged
      ? productFlavor === "preview"
        ? "zcode-cli-rust"
        : "ts"
      : "ts";
  const platformName = platform === "darwin" ? "darwin" : platform === "win32" ? "win32" : "linux";
  const archName = process.arch === "x64" ? "x64" : process.arch;
  const platformKey = `${platformName}-${archName}`;
  const base = isPackaged
    ? (options.resourcesPath ?? fail("Electron resourcesPath 不可用"))
    : resolve(bootstrapDir, "../../bundled-agents", platformKey);
  const executable =
    runtime === "ts"
      ? join(base, "glm", "zcode.cjs")
      : join(base, "rust", platform === "win32" ? "zcode-cli-rust.exe" : "zcode-cli-rust");
  if (runtime === "ts") {
    return {
      runtime,
      executable: process.execPath,
      args: [process.execPath, executable, ...argv],
      cwd,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  return { runtime, executable, args: [executable, ...argv], cwd, env: { ...env } };
}

function fail(message: string): never {
  throw new Error(message);
}

export async function executeCliPlan(
  plan: CliPlan,
  platform: NodeJS.Platform,
): Promise<never | void> {
  if (platform !== "win32") {
    const execve = (
      process as typeof process & {
        execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => never;
      }
    ).execve;
    if (!execve) throw new Error("当前 Electron Node 不支持 process.execve，无法无损启动 CLI");
    execve(plan.executable, plan.args, plan.env);
  }
  await new Promise<void>((resolvePromise, reject) => {
    const child: ChildProcess = spawn(plan.executable, plan.args.slice(1), {
      cwd: plan.cwd,
      env: plan.env,
      stdio: "inherit",
      windowsHide: false,
    });
    let terminating = false;
    const forward = (signal: NodeJS.Signals) => {
      if (child.pid && !terminating) child.kill(signal);
    };
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const handler = () => forward(signal);
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (signal) {
        terminating = true;
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 1);
    });
  });
}
