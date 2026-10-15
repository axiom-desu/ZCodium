import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDefaultZCodeAgentCommand } from "@zcode/services/storage-startup";
import {
  ZCODE_AGENT_SERVER_RUNTIME_ENV_KEY,
  resolveDefaultZCodeAgentServerRuntime,
  resolveHostProcessAgentServerRuntimeEnv,
} from "./desktopAgentRuntimeEnv.js";
import { buildHostProcessEnv } from "./desktopRuntimeEnv.js";

// Main 直接依赖 Electron 容器与用户数据目录；这里只替换这两个边界，
// buildHostProcessEnv 与真实 Services resolver 都走生产实现。
vi.mock("./desktopElectronApp.js", () => ({
  isElectronAppPackaged: vi.fn(() => false),
  getElectronAppPath: vi.fn(() => "/tmp/zcode-desktop-agent-runtime-test-appdata"),
}));

vi.mock("@zcode/services/node", () => ({
  getDataBaseDir: () => homedir(),
  getAppConfigDir: () => "/tmp/zcode-desktop-agent-runtime-test-config",
  listSSHConfigAliasesFromLocalConfig: async () => [],
  ZCODE_WINDOWS_APP_INSTALL_DIR_ENV: "ZCODE_WINDOWS_APP_INSTALL_DIR",
}));

const RUNTIME_KEY = ZCODE_AGENT_SERVER_RUNTIME_ENV_KEY;
const MANAGED_KEYS = [RUNTIME_KEY, "ZCODE_AGENT_SERVER_COMMAND", "ZCODE_RUNTIME_ENV"] as const;

let savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  savedEnv = new Map();
  for (const key of MANAGED_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("resolveDefaultZCodeAgentServerRuntime", () => {
  it("打包 preview 默认 Rust", () => {
    expect(
      resolveDefaultZCodeAgentServerRuntime({ isPackaged: true, productFlavor: "preview" }),
    ).toBe("zcode-cli-rust");
  });

  it("打包 production 与未打包两种情况默认 TS", () => {
    expect(
      resolveDefaultZCodeAgentServerRuntime({ isPackaged: true, productFlavor: "production" }),
    ).toBe("ts");
    expect(
      resolveDefaultZCodeAgentServerRuntime({ isPackaged: false, productFlavor: "preview" }),
    ).toBe("ts");
    expect(
      resolveDefaultZCodeAgentServerRuntime({ isPackaged: false, productFlavor: "production" }),
    ).toBe("ts");
  });
});

describe("resolveHostProcessAgentServerRuntimeEnv", () => {
  const packagedPreview = { isPackaged: true, productFlavor: "preview" } as const;

  it("无 override 时写入产品默认", () => {
    expect(resolveHostProcessAgentServerRuntimeEnv(packagedPreview)).toEqual({
      [RUNTIME_KEY]: "zcode-cli-rust",
    });
  });

  it("空白值按未设置处理", () => {
    expect(
      resolveHostProcessAgentServerRuntimeEnv({ ...packagedPreview, inheritedValue: "   " }),
    ).toEqual({ [RUNTIME_KEY]: "zcode-cli-rust" });
  });

  it("显式 ts 保留，可覆盖 Rust 包默认", () => {
    expect(
      resolveHostProcessAgentServerRuntimeEnv({ ...packagedPreview, inheritedValue: " ts " }),
    ).toEqual({ [RUNTIME_KEY]: "ts" });
  });

  it("未知显式值原样透传，交给 Services resolver fail-closed", () => {
    expect(
      resolveHostProcessAgentServerRuntimeEnv({ ...packagedPreview, inheritedValue: "rust" }),
    ).toEqual({ [RUNTIME_KEY]: "rust" });
  });
});

describe("buildHostProcessEnv 的 Agent runtime 默认接线", () => {
  it("packaged preview 无 override 生成 Rust env", () => {
    const env = buildHostProcessEnv({}, { isPackaged: true, productFlavor: "preview" });
    expect(env[RUNTIME_KEY]).toBe("zcode-cli-rust");
    // 默认注入不影响既有运行时键。
    expect(env.ZCODE_ENV).toBeDefined();
    expect(env.ZCODE_RUNTIME_ENV).toBeDefined();
  });

  it("packaged production 默认 TS", () => {
    const env = buildHostProcessEnv({}, { isPackaged: true, productFlavor: "production" });
    expect(env[RUNTIME_KEY]).toBe("ts");
  });

  it("未打包 preview 与 production 默认 TS", () => {
    expect(
      buildHostProcessEnv({}, { isPackaged: false, productFlavor: "preview" })[RUNTIME_KEY],
    ).toBe("ts");
    expect(
      buildHostProcessEnv({}, { isPackaged: false, productFlavor: "production" })[RUNTIME_KEY],
    ).toBe("ts");
  });

  it("显式 ts 保留，不被 packaged preview 默认覆盖", () => {
    const env = buildHostProcessEnv(
      { [RUNTIME_KEY]: "ts" },
      { isPackaged: true, productFlavor: "preview" },
    );
    expect(env[RUNTIME_KEY]).toBe("ts");
  });

  it("显式未知值透传，不被默认吞掉", () => {
    const env = buildHostProcessEnv(
      { [RUNTIME_KEY]: "rust" },
      { isPackaged: true, productFlavor: "preview" },
    );
    expect(env[RUNTIME_KEY]).toBe("rust");
  });

  it("空白 override 按默认", () => {
    const env = buildHostProcessEnv(
      { [RUNTIME_KEY]: "   " },
      { isPackaged: true, productFlavor: "preview" },
    );
    expect(env[RUNTIME_KEY]).toBe("zcode-cli-rust");
  });

  it("process.env 覆盖 hostProcessLocalEnv 的既有优先级保持", () => {
    // rawInheritedEnv 是 { ...hostLocal, ...process.env }：process.env 后合并，必须胜出。
    process.env[RUNTIME_KEY] = "zcode-cli-rust";
    const env = buildHostProcessEnv(
      { [RUNTIME_KEY]: "ts" },
      { isPackaged: false, productFlavor: "production" },
    );
    expect(env[RUNTIME_KEY]).toBe("zcode-cli-rust");
  });
});

describe("Main 生成的默认 Rust env 交给真实 Services resolver", () => {
  async function withIsolatedRuntime(fn: (root: string) => void | Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "zcode-desktop-agent-runtime-"));
    const previousCwd = process.cwd();
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    try {
      process.chdir(root);
      process.env.HOME = root;
      process.env.USERPROFILE = root;
      await fn(root);
    } finally {
      process.chdir(previousCwd);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      await rm(root, { recursive: true, force: true });
    }
  }

  it("缺 zcode-cli-rust binary 时 fail-closed，不回退 TS", async () => {
    const env = buildHostProcessEnv({}, { isPackaged: true, productFlavor: "preview" });
    expect(env[RUNTIME_KEY]).toBe("zcode-cli-rust");

    await withIsolatedRuntime((root) => {
      process.env[RUNTIME_KEY] = env[RUNTIME_KEY] as string;
      process.env.ZCODE_RUNTIME_ENV = "production";
      expect(() =>
        resolveDefaultZCodeAgentCommand({
          workspacePath: join(root, "workspace"),
          workspaceKey: join(root, "workspace"),
        }),
      ).toThrow(/zcode-cli-rust|Rust/i);
    });
  });

  it("custom command 仍最高优先级，不受默认 Rust 影响", () => {
    const env = buildHostProcessEnv({}, { isPackaged: true, productFlavor: "preview" });
    expect(env[RUNTIME_KEY]).toBe("zcode-cli-rust");

    process.env[RUNTIME_KEY] = env[RUNTIME_KEY] as string;
    process.env.ZCODE_AGENT_SERVER_COMMAND = process.execPath;
    const command = resolveDefaultZCodeAgentCommand({
      workspacePath: "/tmp/zcode-workspace",
      workspaceKey: "/tmp/zcode-workspace",
    });
    expect(command?.command).toBe(process.execPath);
  });
});
