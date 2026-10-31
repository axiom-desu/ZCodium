import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  E2E_ISOLATION_PATH_ENV_KEYS,
  E2E_ISOLATION_ROOT_ENV,
  assertIsolatedEnv,
  createE2EIsolation,
  isPathInside,
  spawnIsolated,
} from "./e2e-isolation.mjs";

// 父进程 HOME 故意设成「像真实用户目录」的值：启动器必须覆盖它，而不是依赖调用者先 export。
const PARENT_HOME = "/home/parent-user-should-never-be-used";
const PARENT_ENV = {
  ...process.env,
  HOME: PARENT_HOME,
  USERPROFILE: PARENT_HOME,
  XDG_CONFIG_HOME: join(PARENT_HOME, ".config"),
  XDG_DATA_HOME: join(PARENT_HOME, ".local/share"),
  ZCODE_DATA_BASE_DIR: PARENT_HOME,
  ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA: "1",
  ELECTRON_RUN_AS_NODE: "1",
};

const cleanup: string[] = [];
afterAll(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

function runNode(args: string[], env: Record<string, string | undefined>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((accept) => {
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => accept({ code, stdout, stderr }));
  });
}

describe("E2E 入口隔离", () => {
  it("自建临时 HOME/XDG/appData/数据根，全部落在系统临时目录内", async () => {
    const isolation = await createE2EIsolation({ parentEnv: PARENT_ENV });
    cleanup.push(isolation.root);

    expect(isPathInside(isolation.root, tmpdir())).toBe(true);
    for (const key of E2E_ISOLATION_PATH_ENV_KEYS) {
      const value = isolation.env[key];
      expect(value, `${key} 必须被隔离覆盖`).toBeTruthy();
      expect(isPathInside(value!, PARENT_HOME), `${key} 泄漏了真实 HOME`).toBe(false);
      expect(isPathInside(value!, isolation.root), `${key} 不在隔离根内`).toBe(true);
    }
    // 会改变默认 userData 的开关必须清掉，否则显式 ZCODE_DESKTOP_USER_DATA_DIR 被忽略。
    expect(isolation.env.ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA).toBeUndefined();
    expect(isolation.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(isolation.env[E2E_ISOLATION_ROOT_ENV]).toBe(isolation.root);
    expect(assertIsolatedEnv(isolation.env)).toBe(isolation.root);
    expect((await stat(isolation.dirs.storageDir)).isDirectory()).toBe(true);
    await expect(stat(isolation.env.ZCODE_SESSION_DB!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("子 runner 收到完整隔离 env 与原始 argv，父进程 HOME 为默认值时同样成立", async () => {
    const isolation = await createE2EIsolation({ parentEnv: PARENT_ENV });
    cleanup.push(isolation.root);
    const probe = join(isolation.dirs.tmp, "probe.mjs");
    await writeFile(
      probe,
      `import { homedir, tmpdir } from "node:os";
       process.stdout.write(JSON.stringify({
         argv: process.argv.slice(2),
         env: process.env,
         homedir: homedir(),
         tmpdir: tmpdir(),
       }));`,
    );

    const flags = ["--rows-only", "--reuse-agent-build"];
    const child = spawnIsolated([probe, ...flags], { env: isolation.env, stdio: "pipe" });
    let stdout = "";
    child.stdout!.on("data", (chunk) => (stdout += chunk));
    const code = await new Promise<number | null>((accept) => child.on("exit", accept));

    expect(code).toBe(0);
    const probeResult = JSON.parse(stdout) as {
      argv: string[];
      env: Record<string, string>;
      homedir: string;
      tmpdir: string;
    };
    expect(probeResult.argv).toEqual(flags);
    for (const key of E2E_ISOLATION_PATH_ENV_KEYS) {
      expect(probeResult.env[key]).toBe(isolation.env[key]);
      expect(isPathInside(probeResult.env[key]!, isolation.root)).toBe(true);
    }
    // Node 自己解析出的 HOME/TMP 也必须指向隔离根，证明不只是 env 里写了个值。
    expect(isPathInside(probeResult.homedir, isolation.root)).toBe(true);
    expect(isPathInside(probeResult.tmpdir, isolation.root)).toBe(true);
  });

  it("非隔离 env 会被断言拒绝（不会静默回退到真实 HOME）", () => {
    expect(() => assertIsolatedEnv(PARENT_ENV)).toThrow(/隔离启动器/);
    expect(() => spawnIsolated(["-e", "0"], { env: PARENT_ENV })).toThrow(/隔离启动器/);
  });

  it.each(["mcp-apps-host-e2e.mjs", "gen-ui-e2e.mjs"])(
    "%s 入口自身解析出的路径全部在临时根内（父 HOME 为默认值）",
    async (name) => {
      const entry = fileURLToPath(new URL(name, import.meta.url));
      // 父进程保留开发者默认 HOME；入口必须自己建立并覆盖隔离环境，不能依赖 ZCODE_DATA_BASE_DIR。
      const parentEnv: Record<string, string | undefined> = { ...process.env };
      delete parentEnv[E2E_ISOLATION_ROOT_ENV];
      const { code, stdout, stderr } = await runNode(
        [entry, "--print-isolation", "--rows-only"],
        parentEnv,
      );
      expect(code, stderr).toBe(0);
      const resolved = JSON.parse(stdout) as {
        root: string;
        argv: string[];
        paths: Record<string, string>;
      };
      expect(isPathInside(resolved.root, tmpdir())).toBe(true);
      expect(isPathInside(resolved.root, PARENT_HOME)).toBe(false);
      for (const key of E2E_ISOLATION_PATH_ENV_KEYS) {
        expect(resolved.paths[key], `${key} 未解析`).toBeTruthy();
        expect(isPathInside(resolved.paths[key]!, resolved.root), `${key} 不在临时根内`).toBe(true);
      }
      // 既有 flag 原样保留，命令兼容性不受隔离启动影响。
      expect(resolved.argv).toEqual(["--print-isolation", "--rows-only"]);
    },
  );

  it("runner 的 evidence 临时目录落在隔离 TMPDIR 内", async () => {
    const isolation = await createE2EIsolation({ parentEnv: PARENT_ENV });
    cleanup.push(isolation.root);
    const output = await mkdtemp(join(isolation.env.TMPDIR!, "zcode-probe-"));
    cleanup.push(output);
    expect(isPathInside(output, isolation.root)).toBe(true);
    expect(isPathInside(output, isolation.dirs.tmp)).toBe(true);
  });
});
