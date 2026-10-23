// Static/fixture guard for the real slow-ACK responsiveness acceptance.
//
// The PTY assertions are intentionally enumerated here so a later refactor cannot
// delete a required behaviour (or replace it with a count that was never executed)
// while the CI step still looks green. This file is picked up by the existing
// `pnpm test:zcode-cli-rust-drivers` script set.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

const REQUIRED_CHECKS = [
  "submit: sessionReady reached a real actor Ready state",
  "submit: first draft visible in strict main composer",
  "submit: write lock held before Enter",
  "submit: no model request while admission is blocked",
  "submit: NEXT_DRAFT visible before unlock",
  "submit: repeated Enter did not admit a second request",
  "submit: repeated Enter kept the new draft",
  "submit: repeated Enter reported the waiting operation",
  "submit: write lock still held when assertions completed",
  "submit: exactly one admission after unlock",
  "submit: ACK did not delete the waiting draft",
  "submit: temp DB history contains only the accepted draft",
  "submit: new submitted draft was accepted and promoted",
  "submit: temp DB history has both accepted drafts exactly once",
  "submit: input history transaction matches accepted inputs",
  "submit: process exits 0",
  "setting: sessionReady reached a real actor Ready state",
  "setting: typed draft visible while setting waits for the lock",
  "setting: real setting ACK row absent until the lock is released",
  "setting: setting ACK refreshed the snapshot after unlock",
  "setting: real setting ACK row recorded in temp DB",
  "setting: ACK kept the newer draft",
  "setting: setting did not create a model request",
  "setting: process exits 0",
  "ctrl-d: sessionReady reached a real actor Ready state",
  "ctrl-d: exits 0 while write lock is still held",
  "ctrl-d: termios restored before unlock",
  "quit: sessionReady reached a real actor Ready state",
  "quit: typed draft visible while setting waits for the lock",
  "quit: /quit exits 0 while write lock is still held",
  "quit: termios restored before unlock",
  "sigterm: sessionReady reached a real actor Ready state",
  "sigterm: exits 143 while write lock is still held",
  "sigterm: termios restored before unlock",
  // Interaction/draft commands stay real-PTY usable without sending a request.
  "draft: sessionReady reached a real actor Ready state",
  "draft: @file attachment became a real composer attachment",
  "draft: Ctrl-Y with no alternate kept the body and attachment",
  "draft: Ctrl-Y created no model request",
  "draft: /draft status reported the empty recovery slot locally",
  "draft: /draft swap kept the editor local and sent nothing",
  "draft: /draft discard found no alternate and sent nothing",
  "draft: draft commands created no model request",
  "draft: process exits 0",
  // P1: continue editing while the explicit queue-edit save is still blocked.
  "queue edit: sessionReady reached a real actor Ready state",
  "queue edit: slow model request started a real busy turn",
  "queue edit: busy normal input became an actor-owned queued item",
  "queue edit: /queue pause reached the actor",
  "queue edit: popup opened with the actor-owned body",
  "queue edit: write lock held before the explicit save",
  "queue edit: continuation visible in the popup while the save is blocked",
  "queue edit: blocked save did not commit the new body",
  "queue edit: blocked save created no model request",
  "queue edit: write lock still held when assertions completed",
  "queue edit: actor committed the first save after unlock",
  "queue edit: late ACK kept the continued local edit",
  "queue edit: second explicit save was accepted (no stale rejection)",
  "queue edit: actor queue list shows the continued body",
  "queue edit: queued edit created no model request",
  "queue edit: resumed queue executed the edited body through a new real request",
  "queue edit: promoted row carries the continued body",
  "queue edit: transcript promoted the edited body exactly once",
  "queue edit: process exits 0",
];

/** Every responsive driver module, so a split cannot hide a deleted assertion. */
async function driverSources() {
  const files = (await readdir("scripts/lib"))
    .filter((name) => name.startsWith("zcode-cli-rust-responsive-") && name.endsWith(".py"))
    .sort();
  assert.ok(files.length >= 2, "responsive driver modules are missing");
  return Promise.all(
    files.map(async (file) => `# ${file}\n${await readFile(`scripts/lib/${file}`, "utf8")}`),
  ).then((parts) => parts.join("\n"));
}

async function sources() {
  return {
    pty: await driverSources(),
    smoke: await readFile("scripts/zcode-cli-rust-responsive-smoke.mjs", "utf8"),
    workflow: await readFile(".github/workflows/cli-rust.yml", "utf8"),
    knip: await readFile("knip.json", "utf8"),
    baseline: await readFile("scripts/zcode-cli-rust-tui-smoke.mjs", "utf8"),
    workbench: await readFile("scripts/zcode-cli-rust-workbench-smoke.mjs", "utf8"),
  };
}

test("responsive PTY keeps every required assertion", async () => {
  const { pty } = await sources();
  for (const name of REQUIRED_CHECKS)
    assert.ok(pty.includes(`"${name}"`), `required acceptance check was deleted: ${name}`);
  assert.ok(pty.includes("BEGIN IMMEDIATE"), "real SQLite write lock is missing");
  assert.ok(pty.includes("?mode=ro"), "DB verification must stay read-only");
  assert.ok(pty.includes("before unlock"), "pre-unlock assertions were removed");
  assert.ok(
    pty.includes("while write lock is still held"),
    "shutdown-during-lock assertions were removed",
  );
  assert.ok(pty.includes("WB_REPLY_"), "new requests must wait for a unique reply nonce");
  assert.ok(
    pty.includes("queue_edit_box"),
    "queue-edit assertions must be located inside the independent popup box",
  );
  assert.ok(pty.includes("live_row"), "queue assertions must read the live actor queue bar");
});

test("responsive summary counts the checks it actually ran", async () => {
  const { smoke, pty } = await sources();
  assert.ok(smoke.includes("checkCount: checkNames.length"), "summary count is not derived");
  assert.ok(
    smoke.includes("const checkNames = result.checks.map((entry) => entry.name)"),
    "summary must use the driver's executed check names",
  );
  assert.ok(!/checkCount:\s*\d+/.test(smoke), "summary must not hard-code a fictional check count");
  assert.ok(smoke.includes("modelRequestCount: requests.length"), "request count is not derived");
  assert.ok(
    smoke.includes("assert.equal(result.coverage.realDbStartupBoot, false"),
    "boot must not be claimed as real DB E2E",
  );
  assert.ok(smoke.includes("59ddf0bc"), "old-main baseline evidence is missing");
  assert.ok(pty.includes("realDbStartupBoot"), "boot coverage marker is missing from the driver");
  assert.ok(
    !smoke.includes("modelRequestCount: 4") && !/requests\.length, \d+/.test(smoke),
    "request assertions must not hard-code a fictional request count",
  );
});

test("CI runs the new acceptance without replacing old baselines", async () => {
  const { workflow, knip, baseline, workbench } = await sources();
  assert.ok(
    workflow.includes("node scripts/zcode-cli-rust-responsive-smoke.mjs"),
    "workflow step for the responsive acceptance is missing",
  );
  assert.ok(
    workflow.includes("node scripts/zcode-cli-rust-tui-smoke.mjs --provider-discovery"),
    "original 20-request TUI baseline was replaced",
  );
  assert.ok(
    workflow.includes("node scripts/zcode-cli-rust-workbench-smoke.mjs"),
    "original workbench baseline was replaced",
  );
  assert.ok(baseline.includes("baselineRequests.length"), "original TUI request baseline changed");
  assert.ok(workbench.includes("SCENARIOS"), "original workbench scenarios changed");
  assert.ok(
    !knip.includes('"scripts/zcode-cli-rust-responsive-smoke.mjs"'),
    "the new smoke is discovered by knip; a redundant explicit entry would fail the gate",
  );
});

test("responsive PTY uses only the temporary isolation contract", async () => {
  const { pty, smoke } = await sources();
  assert.ok(smoke.includes("ZCODE_SESSION_DB_PATH") || smoke.includes("prepareTuiHome"));
  assert.ok(smoke.includes("XDG_DATA_HOME"), "temporary XDG data home is missing");
  assert.ok(smoke.includes("XDG_STATE_HOME"), "temporary XDG state home is missing");
  assert.ok(smoke.includes("XDG_CACHE_HOME"), "temporary XDG cache home is missing");
  assert.ok(smoke.includes("scopes: { main, queue }"), "queue case must run in its own scope");
  assert.ok(pty.includes('config["db"]'), "driver must use the temporary database path");
  assert.ok(!pty.includes("logs/"), "driver must not touch logs/");
  // The queue case reuses the existing fixture release path instead of inventing one.
  assert.ok(smoke.includes("releaseSlow"), "queue case must release a real slow request");
  assert.ok(
    smoke.includes('request.url === "/release"'),
    "fixture control server must expose the real release endpoint",
  );
});
