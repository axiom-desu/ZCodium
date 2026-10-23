import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { WorkspaceHookTrustRecord } from "@zcode/contracts";

import { createFileWorkspaceHookTrustStore } from "../src/storage/workspace-hook-trust-store.js";

const DIGEST = "a".repeat(64);

function record(workspaceIdentity: string): WorkspaceHookTrustRecord {
  return {
    workspaceIdentity,
    hookDeclarationDigest: DIGEST,
    digestAlgorithm: "sha256",
    decision: "trusted",
    grantedAt: new Date().toISOString(),
    eventAtGrant: "PreToolUse",
    displayCommandAtGrant: "hook",
    sourcePathAtGrant: "/tmp/hook",
  };
}

it("hook trust store keeps grant/load/revoke through file and lock owners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-hook-trust-"));
  try {
    const store = createFileWorkspaceHookTrustStore({
      filePath: join(directory, "security", "workspace-hook-trust-v1.json"),
    });
    await store.grant([record("workspace-a")]);
    const loaded = await store.load();
    assert.equal(loaded.status, "ok");
    assert.equal(loaded.records[0]?.workspaceIdentity, "workspace-a");

    const revoked = await store.revoke({ workspaceIdentity: "workspace-a" });
    assert.deepEqual(revoked.records, []);
    await assert.rejects(
      store.revoke({ workspaceIdentity: "workspace-a", hookDeclarationDigests: [] }),
      /must be undefined or non-empty/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
