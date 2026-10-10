import test from "node:test";
import assert from "node:assert/strict";
import {
  assertAllowlist,
  inventory,
  trimPathAllowlist,
} from "../lib/zcodeCliRustCommandTransforms.mjs";

const schema = (def) => ({ _zod: { def } });
test("rejects an unregistered overwrite path and stale allowlist entries", () => {
  const transforms = new Set(["known.path", "unknown.path"]);
  assert.throws(
    () => assertAllowlist(transforms, new Set(["known.path"])),
    /unlisted: unknown\.path/,
  );
  assert.throws(() => assertAllowlist(new Set(), new Set(["stale.path"])), /stale: stale\.path/);
});

test("rejects unknown schema types, pipe/transform types, and unsupported checks", () => {
  for (const type of ["pipe", "transform", "new_schema_kind"]) {
    assert.throws(() => inventory(schema({ type }), "root"), /Unsupported Zod schema type/);
  }
  assert.throws(
    () =>
      inventory(
        schema({ type: "string", checks: [{ _zod: { def: { check: "new_transform" } } }] }),
        "root",
      ),
    /Unsupported Zod check/,
  );
});

test("rejects a recognized-check list entry without a check discriminator", () => {
  assert.throws(
    () => inventory(schema({ type: "string", checks: [{}] }), "root"),
    /Unsupported Zod check undefined/,
  );
});

test("rejects multiple overwrites on a known string path", () => {
  const overwrite = () => ({ _zod: { def: { check: "overwrite", "x-zcode-trim": true } } });
  assert.throws(
    () => inventory(schema({ type: "string", checks: [overwrite(), overwrite()] }), "known.path"),
    /exactly one string overwrite/,
  );
});

test("records the actual Zod leaf schema and its JSON Schema trim marker", async () => {
  const { z } = await import("zod");
  const { toSchema } = await import("../lib/zcodeCliRustCommandTransforms.mjs");
  const leaf = z.string().trim();
  const state = { transformInventory: new Set(), trimLeaves: [] };
  inventory(leaf, "known.path", state);
  assert.equal(state.trimLeaves.length, 1);
  const cases = [" \uFEFFAbC\u00A0 ", " \t\uFEFF\u00A0\n ", "a  B", "AbC", "\u00A0AbC\uFEFF"];
  assert.deepEqual(
    cases.map((raw) => leaf.safeParse(raw).data),
    ["AbC", "", "a  B", "AbC", "AbC"],
  );
  assert.equal(toSchema(leaf)["x-zcode-trim"], true);
});

test("rejects explicitly false, string, and non-string trim extensions", () => {
  for (const extension of [false, "true", 1, null]) {
    const overwrite = { _zod: { def: { check: "overwrite", "x-zcode-trim": extension } } };
    assert.throws(
      () => inventory(schema({ type: "string", checks: [overwrite] }), "known.path"),
      /Unsupported overwrite extension/,
    );
  }
});

test("the live maintained allowlist has no duplicates", () => {
  assert.equal(trimPathAllowlist.size, 63);
});
