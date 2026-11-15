import assert from "node:assert/strict";
import test from "node:test";
import { buildForkedSessionInput } from "../src/runtime/methods/session-fork-bundle.js";

const runtime = {
  sessionId: "parent-session",
  rootTraceContext: { traceId: "trace-1" },
} as never;

const parentSession = {
  id: "parent-session",
  projectID: "project-1",
  workspaceID: null,
  slug: "parent",
  directory: "/repo",
  path: "/repo",
  title: "Parent",
  version: 1,
  permission: {},
} as never;

test("fork without targetCwd inherits the parent directory", () => {
  const child = buildForkedSessionInput(runtime, parentSession, "child" as never);
  assert.equal(child.directory, "/repo");
  assert.equal(child.path, "/repo");
  assert.equal(child.parentID, "parent-session");
});

test("fork targetCwd persists the worktree directory without changing session history identity", () => {
  const child = buildForkedSessionInput(
    runtime,
    parentSession,
    "child" as never,
    "fork",
    "/managed/worktrees/3f2a/repo",
  );
  assert.equal(child.directory, "/managed/worktrees/3f2a/repo");
  assert.equal(child.path, "/managed/worktrees/3f2a/repo");
  assert.equal(child.parentID, "parent-session");
  assert.equal(child.projectID, "project-1");
});
