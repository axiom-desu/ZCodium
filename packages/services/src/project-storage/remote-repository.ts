import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  RemoteProjectEntry,
  RemoteProjectEntryInput,
  RemoteProjectRefreshEntry,
  RemoteProjectRepositoryContract,
} from "#src/project-storage/domain/remote-project-contract.js";
import { transaction } from "#src/project-storage/project-repository-read.js";

interface EntryRow {
  entry_id: string;
  host_id: string;
  remote_project_id: string | null;
  cached_name: string;
  cached_roots_json: string;
  cached_deleted: number;
  last_synced_at: number | null;
}

function toEntry(row: EntryRow): RemoteProjectEntry {
  return {
    entryId: row.entry_id,
    hostId: row.host_id,
    remoteProjectId: row.remote_project_id,
    name: row.cached_name,
    roots: JSON.parse(row.cached_roots_json) as string[],
    cachedDeleted: row.cached_deleted === 1,
    lastSyncedAt: row.last_synced_at,
  };
}

const SELECT = `SELECT entry_id,host_id,remote_project_id,cached_name,cached_roots_json,cached_deleted,last_synced_at
 FROM remote_project_entries`;

export class RemoteProjectRepository implements RemoteProjectRepositoryContract {
  constructor(
    private readonly db: DatabaseSync,
    private readonly ownerHostId?: string,
  ) {}

  private get hostScope(): string | undefined {
    return this.ownerHostId;
  }

  /** membership 是本地持有标识；不一致说明调用方来自旧连接/旧窗口，写库前必须失败。 */
  private assertMembership(hostId: string, membershipId: string): void {
    const row = this.db.prepare("SELECT membership_id FROM hosts WHERE host_id=?").get(hostId) as
      | { membership_id: string | null }
      | undefined;
    if (!row) throw new Error("remote-project.host-unknown");
    if (!row.membership_id || row.membership_id !== membershipId)
      throw new Error("remote-project.membership-stale");
  }

  private read(entryId: string, hostId?: string): RemoteProjectEntry {
    const scope = hostId ?? this.hostScope;
    const row = (
      scope
        ? this.db.prepare(`${SELECT} WHERE entry_id=? AND host_id=?`).get(entryId, scope)
        : this.db.prepare(`${SELECT} WHERE entry_id=?`).get(entryId)
    ) as EntryRow | undefined;
    if (!row) throw new Error("remote-project.not-found");
    return toEntry(row);
  }

  list(hostId?: string): RemoteProjectEntry[] {
    const scope = hostId ?? this.hostScope;
    const rows = (scope
      ? this.db.prepare(`${SELECT} WHERE host_id=? ORDER BY cached_name,entry_id`).all(scope)
      : this.db
          .prepare(`${SELECT} ORDER BY host_id,cached_name,entry_id`)
          .all()) as unknown as EntryRow[];
    return rows.map(toEntry);
  }

  add(input: RemoteProjectEntryInput): RemoteProjectEntry {
    return transaction(this.db, () => {
      this.assertMembership(input.hostId, input.membershipId);
      const roots = JSON.stringify(input.roots);
      const existing = this.db
        .prepare(
          "SELECT entry_id FROM remote_project_entries WHERE host_id=? AND remote_project_id=?",
        )
        .get(input.hostId, input.remoteProjectId) as { entry_id: string } | undefined;
      if (existing) {
        // 显式添加/恢复刷新清除离线删除缓存；不新建第二个 entry。
        this.db
          .prepare(
            "UPDATE remote_project_entries SET cached_name=?,cached_roots_json=?,cached_deleted=0,last_synced_at=? WHERE entry_id=?",
          )
          .run(input.name, roots, Date.now(), existing.entry_id);
        return this.read(existing.entry_id, input.hostId);
      }
      const entryId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO remote_project_entries(entry_id,host_id,remote_project_id,cached_name,cached_roots_json,cached_deleted,last_synced_at)
           VALUES(?,?,?,?,?,0,?)`,
        )
        .run(entryId, input.hostId, input.remoteProjectId, input.name, roots, Date.now());
      return this.read(entryId, input.hostId);
    });
  }

  refresh(input: {
    hostId: string;
    membershipId: string;
    entries: readonly RemoteProjectRefreshEntry[];
    now?: number;
  }): RemoteProjectEntry[] {
    return transaction(
      this.db,
      () => {
        this.assertMembership(input.hostId, input.membershipId);
        const now = input.now ?? Date.now();
        for (const entry of input.entries) {
          if (entry.deleted) {
            // 缓存删除只隐藏离线投影；已移除的本机入口不会被刷新重建。
            this.db
              .prepare(
                "UPDATE remote_project_entries SET cached_deleted=1,last_synced_at=? WHERE host_id=? AND remote_project_id=? AND cached_deleted=0",
              )
              .run(now, input.hostId, entry.remoteProjectId);
            continue;
          }
          this.db
            .prepare(
              `UPDATE remote_project_entries SET cached_name=?,cached_roots_json=?,last_synced_at=?
             WHERE host_id=? AND remote_project_id=? AND cached_deleted=0`,
            )
            .run(entry.name, JSON.stringify(entry.roots), now, input.hostId, entry.remoteProjectId);
        }
        return this.list(input.hostId);
      },
      true,
    );
  }

  remove(entryId: string, hostId?: string): void {
    const scope = hostId ?? this.hostScope;
    const result = scope
      ? this.db
          .prepare("DELETE FROM remote_project_entries WHERE entry_id=? AND host_id=?")
          .run(entryId, scope)
      : this.db.prepare("DELETE FROM remote_project_entries WHERE entry_id=?").run(entryId);
    // 幂等：已移除的入口再删不报错，但不存在与跨 Host 都不伪造成功。
    if (Number(result.changes) === 0) {
      const exists = this.db
        .prepare("SELECT 1 FROM remote_project_entries WHERE entry_id=?")
        .get(entryId);
      if (exists) throw new Error("remote-project.host-mismatch");
    }
  }

  restore(entryId: string, hostId?: string): RemoteProjectEntry {
    return transaction(this.db, () => {
      const entry = this.read(entryId, hostId);
      this.db
        .prepare("UPDATE remote_project_entries SET cached_deleted=0 WHERE entry_id=?")
        .run(entryId);
      return { ...entry, cachedDeleted: false };
    });
  }
}
