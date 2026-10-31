import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  areTasksDatabaseMigrationsApplied,
  inspectTasksMigrationKind,
  runTasksDatabaseMigrations,
} from "#src/session/tasksDatabase/migrations.js";
import { admitTaskGroupFacts } from "#src/session/taskGroupAdmissions.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

const resources: Array<{ db?: DatabaseSync; directory: string; repos: TaskIndexRepo[] }> = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    for (const repo of resource.repos) repo.close();
    resource.db?.close();
    await rm(resource.directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "zcode-tasks-migrations-"));
  const path = join(directory, "tasks-index.sqlite");
  const db = new DatabaseSync(path);
  const resource = { db, directory, repos: [] };
  resources.push(resource);
  return { db, path, directory };
}

describe("tasks index migrations", () => {
  it("applies the frozen base ledger including both additive 0004/0006 migrations", async () => {
    const { db } = await fixture();
    await runTasksDatabaseMigrations(db);
    expect(
      db
        .prepare("SELECT id FROM tasks_schema_migration ORDER BY id")
        .all()
        .map((row) => row.id),
    ).toEqual([
      "0001_adopt_task_schema",
      "0002_provider_selection",
      "0003_official_glm_selection",
      "0004_project_execution_scopes",
      "0006_task_group_admissions",
    ]);
    expect(areTasksDatabaseMigrationsApplied(db)).toBe(true);
    expect(inspectTasksMigrationKind(db)).toBe("none");
    expect(
      db.prepare("SELECT count(*) AS n FROM pragma_table_info('task_group_admissions')").get(),
    ).toEqual({ n: 5 });
    expect(
      db
        .prepare(
          "SELECT name FROM pragma_table_info('automations') WHERE name='additional_directories'",
        )
        .get(),
    ).toEqual({ name: "additional_directories" });
  });

  it("keeps the legacy checksum algorithm for the historical 0002 migration", async () => {
    const { db } = await fixture();
    await runTasksDatabaseMigrations(db);
    const legacy = createHash("sha256")
      .update(
        JSON.stringify(["legacy-automation-selection-v1", "no-provider-for-legacy-off-peak-v1"]),
      )
      .digest("hex");
    expect(
      db
        .prepare("SELECT checksum FROM tasks_schema_migration WHERE id='0002_provider_selection'")
        .get(),
    ).toEqual({ checksum: legacy });
  });

  it("upgrades a partially migrated database without touching existing rows", async () => {
    const { db } = await fixture();
    await runTasksDatabaseMigrations(db);
    db.exec(`INSERT INTO task_groups(group_id,title,color,created_at,updated_at) VALUES('kept','Kept','blue',1,2);
      INSERT INTO tasks(workspace_key,workspace_path,task_id,title,created_at,updated_at,deleted)
        VALUES('/work','/work','t1','kept task',1,2,1);
      INSERT INTO automations(automation_id,title,cron_expr,prompt,workspace_key,workspace_path,created_at,updated_at)
        VALUES('a1','A','* * * * *','p','/work','/work',1,2);
      DELETE FROM tasks_schema_migration WHERE id IN ('0004_project_execution_scopes','0006_task_group_admissions');
      DROP TABLE task_group_admissions;
      ALTER TABLE automations DROP COLUMN project_id;
      ALTER TABLE automations DROP COLUMN host_id;
      ALTER TABLE automations DROP COLUMN additional_directories;`);
    const result = await runTasksDatabaseMigrations(db);
    expect(result.applied).toEqual(["0004_project_execution_scopes", "0006_task_group_admissions"]);
    expect(db.prepare("SELECT count(*) AS n FROM task_groups").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT title,deleted FROM tasks").get()).toEqual({
      title: "kept task",
      deleted: 1,
    });
    expect(db.prepare("SELECT automation_id FROM automations").get()).toEqual({
      automation_id: "a1",
    });
    expect(
      db
        .prepare(
          "SELECT name FROM pragma_table_info('automations') WHERE name='additional_directories'",
        )
        .get(),
    ).toEqual({ name: "additional_directories" });
  });

  it("fails closed on ledger checksum drift", async () => {
    const { db } = await fixture();
    await runTasksDatabaseMigrations(db);
    db.exec(
      "UPDATE tasks_schema_migration SET checksum='deadbeef' WHERE id='0001_adopt_task_schema'",
    );
    expect(() => inspectTasksMigrationKind(db)).toThrow();
    await expect(runTasksDatabaseMigrations(db)).rejects.toMatchObject({
      kind: "checksum_mismatch",
    });
  });

  it("records task-group admission once and never lets late creation replace user organization", async () => {
    const { db } = await fixture();
    await runTasksDatabaseMigrations(db);
    const task = { workspacePath: "/w", taskId: "t", createdAt: 1 };
    admitTaskGroupFacts(db, [{ ...task, cronAutomationId: "cron-1" }]);
    admitTaskGroupFacts(db, [{ ...task, cronAutomationId: "cron-2" }]);
    expect(db.prepare("SELECT * FROM task_group_admissions").get()).toMatchObject({
      workspace_key: "/w",
      task_id: "t",
      system_kind: "cron",
      user_organized: 0,
      creation_id: null,
    });
    // 用户在创建回包前已手动整理：成员关系存在即视为用户整理，迟到 creationId 不得改归属。
    db.exec(
      "INSERT INTO task_groups(group_id,title,created_at,updated_at) VALUES('manual','Manual',1,1); INSERT INTO task_group_members(group_id,workspace_key,workspace_path,task_id,added_at,created_at,updated_at) VALUES('manual','/w','/w','t',1,1,1)",
    );
    admitTaskGroupFacts(db, [{ ...task, deleted: true }]);
    expect(db.prepare("SELECT user_organized FROM task_group_admissions").get()).toEqual({
      user_organized: 1,
    });
    expect(db.prepare("SELECT count(*) AS n FROM task_group_members").get()).toEqual({ n: 0 });
    // 重复登记保持一行，不重复计入。
    admitTaskGroupFacts(db, [{ ...task, cronAutomationId: "cron-1" }]);
    expect(db.prepare("SELECT count(*) AS n FROM task_group_admissions").get()).toEqual({ n: 1 });
  });

  it("composes worker-style migration with injected settings and exposes the Host project port", async () => {
    const { path } = await fixture();
    const repo = new TaskIndexRepo(path, 5000, {
      settings: {
        recentProjects: [],
        lastWorkspaceSession: [{ kind: "local", workspacePath: "/seeded" }],
      },
    });
    resources[resources.length - 1]!.repos.push(repo);
    await repo.ensureReady();
    const projectRepository = await repo.getProjectRepository();
    expect(projectRepository.readTree().projects).toMatchObject([
      { name: "seeded", hostId: "local" },
    ]);
    expect(repo.migrationBackupSkipped).toBe(false);
  });
});
