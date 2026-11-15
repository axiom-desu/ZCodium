import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ISettingService } from "#src/setting/setting.js";
import { createTerminalService } from "#src/terminal/terminalService.js";
import { isTerminalHoldingDirectory } from "#src/terminal/terminalCwd.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("terminal cwd occupancy", () => {
  it("treats a non-Linux platform as unprovable and conservatively occupied", () => {
    expect(
      isTerminalHoldingDirectory({
        platform: "darwin",
        initialCwd: "/tmp/project",
        directory: "/tmp/project/worktree",
        snapshot: null,
      }),
    ).toBe(true);
    expect(
      isTerminalHoldingDirectory({
        platform: "win32",
        initialCwd: "C:\\project",
        directory: "C:\\project\\worktree",
        snapshot: null,
      }),
    ).toBe(true);
  });

  it("only clears a terminal when the Linux process snapshot proves every cwd is outside", () => {
    expect(
      isTerminalHoldingDirectory({
        platform: "linux",
        initialCwd: "/tmp/project",
        directory: "/tmp/project/worktree",
        snapshot: { sawRoot: true, cwds: ["/tmp/project"], unreadable: false },
      }),
    ).toBe(false);
    // 后代 cwd 进入目标目录：占用。
    expect(
      isTerminalHoldingDirectory({
        platform: "linux",
        initialCwd: "/tmp/project",
        directory: "/tmp/project/worktree",
        snapshot: {
          sawRoot: true,
          cwds: ["/tmp/project", "/tmp/project/worktree/sub"],
          unreadable: false,
        },
      }),
    ).toBe(true);
    // 根进程不可见或读不到 cwd：无法证明，保守占用。
    expect(
      isTerminalHoldingDirectory({
        platform: "linux",
        initialCwd: "/tmp/project",
        directory: "/tmp/project/worktree",
        snapshot: { sawRoot: false, cwds: [], unreadable: false },
      }),
    ).toBe(true);
    expect(
      isTerminalHoldingDirectory({
        platform: "linux",
        initialCwd: "/tmp/project",
        directory: "/tmp/project/worktree",
        snapshot: { sawRoot: true, cwds: ["/tmp/project"], unreadable: true },
      }),
    ).toBe(true);
    expect(
      isTerminalHoldingDirectory({
        platform: "linux",
        initialCwd: "/tmp/project",
        directory: "/tmp/project/worktree",
        snapshot: null,
      }),
    ).toBe(true);
  });

  it.runIf(process.platform === "linux")(
    "detects a real PTY that cd'd into the managed directory",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "zcode-terminal-cwd-"));
      directories.push(directory);
      const projectRoot = join(directory, "project");
      const worktree = join(directory, "project", "worktree");
      await mkdir(worktree, { recursive: true });
      const service = createTerminalService({
        settingService: { get: async () => ({}) } as unknown as ISettingService,
      });
      const terminal = await service.create({ cols: 80, rows: 24, cwd: projectRoot });
      try {
        // 壳进程还没被 /proc 观察到时也是保守占用；等到能证明“未进入目标目录”。
        let outside = false;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          if ((await service.listTerminalIdsUnderPath({ path: worktree })).length === 0) {
            outside = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(outside).toBe(true);
        await service.write({ id: terminal.id, data: `cd '${worktree}'\n` });
        const deadlineAfterCd = Date.now() + 10_000;
        let held = false;
        while (Date.now() < deadlineAfterCd) {
          if ((await service.listTerminalIdsUnderPath({ path: worktree })).includes(terminal.id)) {
            held = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(held).toBe(true);
      } finally {
        await service.dispose({ id: terminal.id }).catch(() => undefined);
      }
    },
  );
});
