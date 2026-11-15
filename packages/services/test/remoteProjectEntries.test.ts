import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { projectStorage } from "#src/project-storage/index.js";
import { createRemoteProjectService } from "#src/remote-projects/index.js";

const resources: Array<{ db: DatabaseSync; directory: string }> = [];
afterEach(async () => {
  for (const { db, directory } of resources.splice(0)) {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "zcode-remote-projects-"));
  const db = new DatabaseSync(join(directory, "tasks-index.sqlite"));
  resources.push({ db, directory });
  db.exec(`CREATE TABLE tasks (
    workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT,
    task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', task_status TEXT,
    provider TEXT DEFAULT 'glm', mode TEXT NOT NULL DEFAULT 'build', model TEXT,
    migration_source TEXT, forked_from_task_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, unread_at INTEGER,
    last_unread_at INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
    title_overridden INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY(workspace_key, task_id));`);
  await projectStorage.migrate(db, {
    backupDirectories: [join(directory, "backup")],
    settings: { lastWorkspaceSession: [], recentProjects: [] },
  });
  db.prepare("INSERT INTO hosts(host_id,kind,membership_id,position) VALUES(?,?,?,?)").run(
    "source-a",
    "remote",
    "membership-1",
    0,
  );
  const repository = projectStorage.remoteProjects(db);
  const service = createRemoteProjectService({
    repository: async () => repository,
    readLocalProjects: async () => [],
  });
  return { db, repository, service };
}

describe("remote project entry intent", () => {
  it("persists explicit intent with membership CAS and membership-only removal", async () => {
    const { db, service } = await fixture();
    const added = await service.addEntry({
      hostId: "source-a",
      membershipId: "membership-1",
      remoteProjectId: "remote-1",
      name: "Remote",
      roots: ["/remote/repo"],
    });
    expect(added).toMatchObject({ name: "Remote", roots: ["/remote/repo"], cachedDeleted: false });
    expect(await service.listEntries({ hostId: "source-a" })).toHaveLength(1);
    await expect(
      service.addEntry({
        hostId: "source-a",
        membershipId: "old-window",
        remoteProjectId: "remote-2",
        name: "Late",
        roots: ["/remote/late"],
      }),
    ).rejects.toThrow("remote-project.membership-stale");
    await service.removeEntry({ entryId: added.entryId, hostId: "source-a" });
    expect(await service.listEntries({ hostId: "source-a" })).toEqual([]);
    // 只删本机 entry；hosts 连接事实行仍在。
    expect(db.prepare("SELECT host_id FROM hosts WHERE host_id=?").all("source-a")).toEqual([
      { host_id: "source-a" },
    ]);
  });

  it("caches remote deletion, hides it from catalog, and never rebuilds removed entries", async () => {
    const { service } = await fixture();
    const added = await service.addEntry({
      hostId: "source-a",
      membershipId: "membership-1",
      remoteProjectId: "remote-1",
      name: "Remote",
      roots: ["/remote/repo"],
    });
    await service.refreshDirectory({
      hostId: "source-a",
      membershipId: "membership-1",
      entries: [
        {
          remoteProjectId: "remote-1",
          name: "Remote renamed",
          roots: ["/remote/next"],
          deleted: false,
        },
      ],
    });
    expect(await service.listEntries({ hostId: "source-a" })).toMatchObject([
      { name: "Remote renamed", roots: ["/remote/next"] },
    ]);
    await service.refreshDirectory({
      hostId: "source-a",
      membershipId: "membership-1",
      entries: [{ remoteProjectId: "remote-1", name: "Remote", roots: [], deleted: true }],
    });
    const catalog = await service.readCatalog({ hostId: "source-a" });
    expect(catalog).toMatchObject({ localProjects: [], remoteProjects: [] });
    expect(await service.listEntries({ hostId: "source-a" })).toMatchObject([
      { entryId: added.entryId, cachedDeleted: true },
    ]);
    // 迟到刷新不得重建/复活已缓存删除入口。
    await service.refreshDirectory({
      hostId: "source-a",
      membershipId: "membership-1",
      entries: [
        { remoteProjectId: "remote-1", name: "Late", roots: ["/remote/late"], deleted: false },
      ],
    });
    expect(await service.listEntries({ hostId: "source-a" })).toMatchObject([
      { name: "Remote renamed", cachedDeleted: true },
    ]);
    // 显式恢复/添加清除缓删除标记；随后刷新再次更新。
    expect(
      await service.restoreEntry({ entryId: added.entryId, hostId: "source-a" }),
    ).toMatchObject({
      cachedDeleted: false,
    });
    await service.removeEntry({ entryId: added.entryId, hostId: "source-a" });
    await service.refreshDirectory({
      hostId: "source-a",
      membershipId: "membership-1",
      entries: [{ remoteProjectId: "remote-1", name: "Ghost", roots: [], deleted: false }],
    });
    expect(await service.listEntries({ hostId: "source-a" })).toEqual([]);
  });
});
