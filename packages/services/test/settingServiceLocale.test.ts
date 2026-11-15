import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZCODE_USER_DATA_DIR_NAME } from "@zcode/shared";
import { createSettingService } from "#src/setting/settingService.js";

const homes: string[] = [];
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.HOME;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

describe("locale setting persistence", () => {
  it("round-trips the selected locale through the existing setting service", async () => {
    const home = await mkdtemp(join(tmpdir(), "zcode-locale-"));
    homes.push(home);
    process.env.HOME = home;
    delete process.env.USERPROFILE;
    const service = createSettingService();
    await service.update({ locale: "ja-JP", localePreference: "ja-JP" });

    const file = join(home, ZCODE_USER_DATA_DIR_NAME, "v2", "setting.json");
    const persisted = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      locale: "en-US",
      localePreference: "en-US",
      uiLocale: "ja-JP",
      uiLocalePreference: "ja-JP",
    });
    await expect(service.get()).resolves.toMatchObject({
      locale: "ja-JP",
      localePreference: "ja-JP",
    });
  });
});
