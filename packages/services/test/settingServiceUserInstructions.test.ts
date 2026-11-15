import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  USER_INSTRUCTIONS_MAX_BYTES,
  USER_INSTRUCTIONS_TOO_LARGE_ERROR_CODE,
  ZCODE_USER_DATA_DIR_NAME,
} from "@zcode/shared";
import { getAgentUserInstructionsFilePath } from "#src/paths.js";
import { createSettingService } from "#src/setting/settingService.js";

/**
 * 真实 SettingService + 临时 HOME：验证个性化指令确实读写 `{HOME}/.zcodium/AGENTS.md`，
 * 且与 CLI 读取同一路径。只使用 mkdtemp 出来的目录，不触碰真实用户数据。
 */
const homes: string[] = [];
let previousHome: string | undefined;

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "zcode-user-instructions-"));
  homes.push(home);
  previousHome = process.env.HOME;
  process.env.HOME = home;
  delete process.env.USERPROFILE;
  return home;
}

function instructionsFile(home: string): string {
  return join(home, ZCODE_USER_DATA_DIR_NAME, "AGENTS.md");
}

beforeEach(() => {
  previousHome = process.env.HOME;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

describe("个性化指令（真实设置服务 + 临时 HOME）", () => {
  it("路径解析到 CLI 读取的用户级 AGENTS.md", async () => {
    const home = await createTempHome();
    expect(getAgentUserInstructionsFilePath()).toBe(instructionsFile(home));
  });

  it("文件不存在等价于未配置：返回空串，不创建文件", async () => {
    const home = await createTempHome();
    const service = createSettingService();
    const result = await service.getUserInstructions();
    expect(result.content).toBe("");
    expect(result.filePath).toBe(instructionsFile(home));
    await expect(stat(instructionsFile(home))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("首次保存会创建目录与文件，并按 0600 收紧权限", async () => {
    const home = await createTempHome();
    const service = createSettingService();
    await service.saveUserInstructions("- 用中文回答\n");
    expect(await readFile(instructionsFile(home), "utf8")).toBe("- 用中文回答\n");
    const mode = (await stat(instructionsFile(home))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("覆盖保存后读取到新内容（写入队列排空后再读）", async () => {
    const home = await createTempHome();
    const service = createSettingService();
    await service.saveUserInstructions("v1");
    await service.saveUserInstructions("v2");
    expect(await readFile(instructionsFile(home), "utf8")).toBe("v2");
    expect((await service.getUserInstructions()).content).toBe("v2");
  });

  it("超过共享字节上限时拒绝并抛出稳定错误码，不写坏文件", async () => {
    const home = await createTempHome();
    await mkdir(join(home, ZCODE_USER_DATA_DIR_NAME), { recursive: true });
    await writeFile(instructionsFile(home), "keep", "utf8");
    const service = createSettingService();
    const tooLarge = "a".repeat(USER_INSTRUCTIONS_MAX_BYTES + 1);
    await expect(service.saveUserInstructions(tooLarge)).rejects.toMatchObject({
      code: USER_INSTRUCTIONS_TOO_LARGE_ERROR_CODE,
    });
    expect(await readFile(instructionsFile(home), "utf8")).toBe("keep");
  });

  it("恰好到达上限仍可保存（多字节中文按 UTF-8 字节计）", async () => {
    const home = await createTempHome();
    await mkdir(join(home, ZCODE_USER_DATA_DIR_NAME), { recursive: true });
    const service = createSettingService();
    // "中" 是 3 字节；生成不超过上限的最大整块。
    const content = "中".repeat(Math.floor(USER_INSTRUCTIONS_MAX_BYTES / 3));
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(USER_INSTRUCTIONS_MAX_BYTES);
    await service.saveUserInstructions(content);
    expect(await readFile(instructionsFile(home), "utf8")).toBe(content);
  });

  it("超限文件只读取前 100KiB 并标记 truncated，不整份读入", async () => {
    const home = await createTempHome();
    await mkdir(join(home, ZCODE_USER_DATA_DIR_NAME), { recursive: true });
    const oversized = "a".repeat(USER_INSTRUCTIONS_MAX_BYTES + 4096);
    await writeFile(instructionsFile(home), oversized, "utf8");
    const service = createSettingService();
    const result = await service.getUserInstructions();
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, "utf8")).toBe(USER_INSTRUCTIONS_MAX_BYTES);
    // 读取上限不能改动磁盘上的完整文件。
    expect((await stat(instructionsFile(home))).size).toBe(oversized.length);
  });

  it("拒绝用截断草稿覆盖超限文件，原文件保持完整", async () => {
    const home = await createTempHome();
    await mkdir(join(home, ZCODE_USER_DATA_DIR_NAME), { recursive: true });
    const oversized = "b".repeat(USER_INSTRUCTIONS_MAX_BYTES + 1);
    await writeFile(instructionsFile(home), oversized, "utf8");
    const service = createSettingService();
    await expect(service.saveUserInstructions("short")).rejects.toMatchObject({
      code: USER_INSTRUCTIONS_TOO_LARGE_ERROR_CODE,
    });
    expect(await readFile(instructionsFile(home), "utf8")).toBe(oversized);
  });

  it("读取非 ENOENT 失败会抛出（UI 走失败 + 重试，不把空串当基线）", async () => {
    const home = await createTempHome();
    const filePath = instructionsFile(home);
    await mkdir(filePath, { recursive: true });
    await chmod(filePath, 0o700);
    const service = createSettingService();
    await expect(service.getUserInstructions()).rejects.toBeTruthy();
  });
});
