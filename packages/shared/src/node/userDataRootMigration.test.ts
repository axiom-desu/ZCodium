import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  LEGACY_ZCODE_USER_DATA_DIR_NAME,
  ZCODE_USER_DATA_DIR_NAME,
  ZCODE_USER_DATA_MIGRATION_MARKER_FILE_NAME,
} from "../appDirNames.js";
import { migrateLegacyUserDataRoot } from "./userDataRootMigration.js";

describe("migrateLegacyUserDataRoot", () => {
  let baseDir: string;
  let legacyRoot: string;
  let nextRoot: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "zcodium-data-root-"));
    legacyRoot = join(baseDir, LEGACY_ZCODE_USER_DATA_DIR_NAME);
    nextRoot = join(baseDir, ZCODE_USER_DATA_DIR_NAME);
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  function seedLegacyTree(): void {
    mkdirSync(join(legacyRoot, "v2"), { recursive: true });
    mkdirSync(join(legacyRoot, "cli", "db"), { recursive: true });
    writeFileSync(join(legacyRoot, "v2", "setting.json"), '{"dataBaseDir":"/tmp/custom"}');
    writeFileSync(join(legacyRoot, "cli", "db", "db.sqlite"), "sqlite-bytes");
  }

  it("把旧根整体搬到新根，内容逐字节保留", () => {
    seedLegacyTree();
    const result = migrateLegacyUserDataRoot({ baseDir });

    assert.equal(result.status, "migrated");
    assert.equal(existsSync(nextRoot), true);
    assert.equal(
      readFileSync(join(nextRoot, "v2", "setting.json"), "utf8"),
      '{"dataBaseDir":"/tmp/custom"}',
    );
    assert.equal(readFileSync(join(nextRoot, "cli", "db", "db.sqlite"), "utf8"), "sqlite-bytes");
  });

  it("迁移后旧根写标记文件，防止重复灌入", () => {
    seedLegacyTree();
    migrateLegacyUserDataRoot({ baseDir });
    const marker = join(legacyRoot, ZCODE_USER_DATA_MIGRATION_MARKER_FILE_NAME);

    assert.equal(existsSync(marker), true);
    const parsed = JSON.parse(readFileSync(marker, "utf8")) as { migratedTo: string };
    assert.equal(parsed.migratedTo, nextRoot);
  });

  it("已有标记时不再迁移（no-op）", () => {
    seedLegacyTree();
    migrateLegacyUserDataRoot({ baseDir });
    // 用户在新根里改了配置，再启动不应被旧根覆盖回去。
    writeFileSync(join(nextRoot, "v2", "setting.json"), '{"dataBaseDir":"/tmp/newer"}');

    const second = migrateLegacyUserDataRoot({ baseDir });

    assert.equal(second.status, "noop-already-migrated");
    assert.equal(
      readFileSync(join(nextRoot, "v2", "setting.json"), "utf8"),
      '{"dataBaseDir":"/tmp/newer"}',
    );
  });

  it("旧根不存在时 no-op（全新安装）", () => {
    const result = migrateLegacyUserDataRoot({ baseDir });

    assert.equal(result.status, "noop-no-legacy");
    assert.equal(existsSync(nextRoot), false);
  });

  it("新旧根同时存在时跳过，不覆盖任何一方", () => {
    seedLegacyTree();
    mkdirSync(join(nextRoot, "v2"), { recursive: true });
    writeFileSync(join(nextRoot, "v2", "setting.json"), '{"dataBaseDir":"/tmp/kept"}');
    writeFileSync(join(legacyRoot, "v2", "setting.json"), '{"dataBaseDir":"/tmp/legacy"}');

    const result = migrateLegacyUserDataRoot({ baseDir });

    assert.equal(result.status, "skipped-both-exist");
    assert.equal(
      readFileSync(join(nextRoot, "v2", "setting.json"), "utf8"),
      '{"dataBaseDir":"/tmp/kept"}',
    );
    assert.equal(
      readFileSync(join(legacyRoot, "v2", "setting.json"), "utf8"),
      '{"dataBaseDir":"/tmp/legacy"}',
    );
    // 跳过时不写标记，避免把"未迁移"误判成"已迁移"而永久放弃。
    assert.equal(existsSync(join(legacyRoot, ZCODE_USER_DATA_MIGRATION_MARKER_FILE_NAME)), false);
  });

  it("自定义基目录下按同一 baseDir 解析", () => {
    const customBase = mkdtempSync(join(tmpdir(), "zcodium-data-base-"));
    try {
      mkdirSync(join(customBase, LEGACY_ZCODE_USER_DATA_DIR_NAME, "v2"), { recursive: true });
      writeFileSync(
        join(customBase, LEGACY_ZCODE_USER_DATA_DIR_NAME, "v2", "setting.json"),
        '{"dataBaseDir":"/tmp/custom"}',
      );

      const result = migrateLegacyUserDataRoot({ baseDir: customBase });

      assert.equal(result.status, "migrated");
      assert.equal(
        readFileSync(join(customBase, ZCODE_USER_DATA_DIR_NAME, "v2", "setting.json"), "utf8"),
        '{"dataBaseDir":"/tmp/custom"}',
      );
    } finally {
      rmSync(customBase, { recursive: true, force: true });
    }
  });

  it("迁移失败不抛异常，返回 failed", () => {
    seedLegacyTree();
    // 把旧根变成文件，cpSync 会以非目录形式失败，走失败分支。
    rmSync(legacyRoot, { recursive: true, force: true });
    writeFileSync(legacyRoot, "not-a-directory");

    const result = migrateLegacyUserDataRoot({ baseDir });

    assert.equal(result.status, "failed");
    assert.ok("error" in result && result.error !== undefined);
  });
});
