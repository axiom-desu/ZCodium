import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNoticeOverrideVersions } from "../third-party-npm.mjs";

test("uninstalled platform notices remain valid only for exact versions in the lockfile", () => {
  const overrides = [{ package: "native-linux-musl@1.0.0" }];
  assert.doesNotThrow(() =>
    assertNoticeOverrideVersions(overrides, new Set(), new Set(["native-linux-musl@1.0.0"])),
  );
  assert.throws(
    () => assertNoticeOverrideVersions(overrides, new Set(), new Set(["native-linux-musl@2.0.0"])),
    /Stale npm notice override/,
  );
  assert.throws(
    () => assertNoticeOverrideVersions(overrides, new Set(), new Set()),
    /Stale npm notice override/,
  );
});
