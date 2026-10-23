// Run through generate-zcode-cli-rust-state-fixtures.mjs. Replays the fixed
// operation list stored in `crates/state/fixtures/node-db.json` through the real
// Node session-store repositories on a fixed clock, then records every table.
// The Rust node repositories replay the same operations and must produce
// byte-identical rows. The operation list is scenario input; every expected
// row is computed by the current TS implementation.
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { runSqliteSessionMigrations } from "../apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.ts";
import * as sessions from "../apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/sessions.ts";
import * as messages from "../apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/messages.ts";
import * as entries from "../apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/session-entries.ts";
import * as inputs from "../apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/session-inputs.ts";
import * as todos from "../apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/todos.ts";
import * as settings from "../apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/local-settings.ts";
import * as history from "../apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/input-history.ts";
import * as targets from "../apps/zcode-cli/packages/adapters/src/storage/session-target.ts";

const FIXTURE = new URL(
  "../apps/zcode-cli-rust/crates/state/fixtures/node-db.json",
  import.meta.url,
);
const TABLES = [
  "session",
  "message",
  "part",
  "session_entry",
  "session_input",
  "todo",
  "session_target",
  "local_setting",
  "input_history",
];

export async function nodeDbFixtures() {
  const current = JSON.parse(await readFile(FIXTURE, "utf8"));
  const operations = current.operations;
  const realNow = Date.now;
  const realUuid = crypto.randomUUID;
  let clock = 0;
  let uuids = [];
  const installClock = () => {
    Date.now = () => clock;
    crypto.randomUUID = () => uuids.shift() ?? realUuid();
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: crypto.randomUUID,
      configurable: true,
    });
    syncBuiltinESMExports();
  };
  installClock();
  try {
    const db = new DatabaseSync(":memory:");
    runSqliteSessionMigrations(db, ":memory:");
    db.exec("pragma foreign_keys = on");
    for (const operation of operations) {
      await apply(
        db,
        operation,
        (next) => (clock = next),
        (uuid) => (uuids = [uuid]),
      );
    }
    const tables = Object.fromEntries(
      TABLES.map((table) => [
        table,
        db
          .prepare(`select * from ${table} order by rowid`)
          .all()
          .map((row) => Object.values(row)),
      ]),
    );
    const read = {
      messages: await messages.messages(db, { sessionID: "sess_a" }),
      entries: entries.sessionEntries(db, { sessionID: "sess_a" }),
      inputs: await inputs.listSessionInputs(db, { sessionID: "sess_a" }),
      list: (
        await sessions.listSessions(db, {
          directory: "/w",
          taskTypes: ["interactive", "subagent_child"],
        })
      ).map((session) => session.id),
    };
    return { operations, tables, read };
  } finally {
    Date.now = realNow;
    crypto.randomUUID = realUuid;
    delete globalThis.crypto.randomUUID;
    syncBuiltinESMExports();
  }
}

async function apply(db, operation, setClock, setUuid) {
  if (operation.now !== undefined) setClock(operation.now);
  if (operation.uuid) setUuid(operation.uuid);
  switch (operation.op) {
    case "exec":
      return db.exec(operation.sql);
    case "createSession":
      return sessions.createSession(db, operation.input);
    case "updateSession":
      return sessions.updateSession(db, operation.input);
    case "softDeleteSession":
      return sessions.softDeleteSession(db, operation.input);
    case "setRevert":
      return sessions.setRevert(db, { sessionID: operation.sessionID, revert: operation.revert });
    case "saveMessage":
      return messages.saveMessage(db, operation.info, operation.copyFrom);
    case "savePart":
      return messages.savePart(db, operation.part, operation.copyFrom);
    case "removeMessage":
      return messages.removeMessage(db, {
        sessionID: operation.sessionID,
        messageID: operation.messageID,
      });
    case "saveEntry":
      return entries.saveSessionEntry(db, operation.entry);
    case "saveInput":
      return inputs.saveSessionInput(db, operation.input);
    case "updateInputs":
      return inputs.updateSessionInputs(db, {
        sessionID: operation.sessionID,
        updates: operation.updates,
      });
    case "promoteInput":
      return inputs.promoteSessionInput(db, operation);
    case "settleInput":
      return inputs.settleSessionInput(db, operation);
    case "markPromoted":
      return inputs.markSessionInputPromoted(db, {
        ...operation,
        promotedMessageID: operation.messageID,
      });
    case "updateTodos":
      return todos.updateTodos(db, operation);
    case "setTarget":
      return targets.setSessionTarget(db, operation);
    case "startTargetRun": {
      const target = targets.readSessionTarget(db, operation);
      return targets.startSessionTargetRun(db, { ...operation, targetID: target.targetID });
    }
    case "heartbeatTargetRun": {
      const target = targets.readSessionTarget(db, operation);
      return targets.heartbeatSessionTargetRun(db, { ...operation, targetID: target.targetID });
    }
    case "finishTargetRun": {
      const target = targets.readSessionTarget(db, operation);
      return targets.finishSessionTargetRun(db, { ...operation, targetID: target.targetID });
    }
    case "recoverTargetRun":
      return targets.recoverInterruptedSessionTargetRun(db, operation);
    case "updateTargetStatus":
      return targets.updateSessionTargetStatus(db, operation);
    case "updateTargetSummaryTitle": {
      const target = targets.readSessionTarget(db, operation);
      return targets.updateSessionTargetSummaryTitle(db, {
        ...operation,
        targetID: target.targetID,
      });
    }
    case "accountTargetUsage": {
      const target = targets.readSessionTarget(db, operation);
      return targets.accountSessionTargetUsage(db, { ...operation, targetID: target.targetID });
    }
    case "savePermissionMode":
      return settings.saveProjectPermissionMode(db, operation);
    case "savePermission":
      return settings.saveProjectPermission(db, operation);
    case "recordInputHistory":
      return history.recordInputHistory(db, operation.input);
    default:
      throw new Error(`unknown op ${operation.op}`);
  }
}
