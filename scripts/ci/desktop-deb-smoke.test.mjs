import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseDebSmokeArgs,
  verifyDebIdentity,
  selectPackagedRuntimeProcesses,
  readOwnDescendantCmdlines,
  appProcessId,
} from "../lib/desktop-deb-smoke.mjs";

test("deb smoke CLI validates absolute inputs and flavor", () => {
  assert.equal(
    parseDebSmokeArgs(["--deb=/tmp/a.deb", "--flavor=preview", "--evidence=/tmp/e"]).flavor,
    "preview",
  );
  assert.throws(
    () => parseDebSmokeArgs(["--deb=relative", "--flavor=preview", "--evidence=/tmp/e"]),
    /absolute/,
  );
});

test("identity validation rejects labeled/malformed control output", () => {
  assert.equal(
    verifyDebIdentity(
      { Package: "zcodium-rust\n", Architecture: "amd64\n", Version: "3.15.1~20261018.374\n" },
      "preview",
      "x64",
      "3.15.1-20261018.374",
    ).version,
    "3.15.1~20261018.374",
  );
  assert.throws(
    () =>
      verifyDebIdentity(
        { Package: "Package: zcodium-rust", Architecture: "amd64", Version: "1" },
        "preview",
        "x64",
      ),
    /identity mismatch/,
  );
  assert.throws(
    () =>
      verifyDebIdentity(
        { Package: "zcodium-rust", Architecture: "amd64", Version: "1", Proto: "bad" },
        "preview",
        "x64",
      ),
    /unexpected/,
  );
  assert.throws(
    () =>
      verifyDebIdentity(
        { Package: "zcodium-rust", Architecture: "amd64", Version: "" },
        "preview",
        "x64",
      ),
    /invalid/,
  );
});

test("deb control version must match the expected build rather than merely being nonempty", () => {
  const fields = { Package: "zcodium-rust", Architecture: "amd64", Version: "3.15.1~20261018.373" };
  assert.throws(
    () => verifyDebIdentity(fields, "preview", "x64", "3.15.1-20261018.374"),
    /version mismatch/,
  );
  assert.throws(() => verifyDebIdentity(fields, "preview", "x64"), /expected build version/);
});

test("closed Playwright connections do not mask cleanup evidence", () => {
  assert.equal(
    appProcessId({
      process() {
        throw new Error("connection closed");
      },
    }),
    undefined,
  );
  assert.equal(
    appProcessId({
      process() {
        return { pid: 42 };
      },
    }),
    42,
  );
});

test("process discovery visits owned children from every thread, not unrelated processes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deb-proc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function thread(pid, tid, children, cmdline) {
    const dir = join(root, String(pid), "task", String(tid));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "children"), children);
    await writeFile(join(root, String(pid), "cmdline"), cmdline);
  }
  await thread(100, 100, "200", "app");
  await thread(100, 101, "300", "app");
  await thread(200, 200, "", "renderer");
  await thread(300, 300, "400", "host");
  await thread(400, 400, "", "/tmp/resources/glm/zcode.cjs");
  await thread(999, 999, "", "unrelated");
  const entries = await readOwnDescendantCmdlines(100, root);
  assert.deepEqual(
    entries.map((entry) => entry.pid),
    [200, 300, 400],
  );
  assert.deepEqual(
    selectPackagedRuntimeProcesses(entries, 100, "/tmp/resources", "production").map(
      (entry) => entry.pid,
    ),
    [400],
  );
});

test("actual runtime predicate requires flavor-specific packaged descendant paths", () => {
  const entries = [
    { pid: 10, ppid: 1, cmdline: "electron" },
    {
      pid: 11,
      ppid: 10,
      cmdline: "/tmp/unpacked/rust/zcode-cli-rust",
      exe: "/tmp/unpacked/rust/zcode-cli-rust",
    },
    { pid: 12, ppid: 1, cmdline: "/tmp/unpacked/rust/zcode-cli-rust" },
    { pid: 13, ppid: 10, cmdline: "/repo/apps/zcode-cli-rust/target/debug/zcode-cli-rust" },
  ];
  assert.throws(
    () => selectPackagedRuntimeProcesses(entries, 10, "/tmp/unpacked", "preview"),
    /development Cargo/,
  );
  assert.deepEqual(
    selectPackagedRuntimeProcesses(entries.slice(0, 3), 10, "/tmp/unpacked", "preview"),
    [entries[1]],
  );
  assert.throws(
    () =>
      selectPackagedRuntimeProcesses(
        [{ ...entries[1], exe: "/usr/bin/node" }],
        10,
        "/tmp/unpacked",
        "preview",
      ),
    /no preview runtime/,
  );
  assert.throws(
    () => selectPackagedRuntimeProcesses(entries, 10, "/tmp/unpacked", "production"),
    /no|runtime/i,
  );
  const titled = {
    pid: 21,
    ppid: 20,
    cmdline: "zcode-cli",
    exe: "/tmp/zcodium-exp",
    electronNodeMode: true,
    runtimeSelection: "ts",
  };
  assert.deepEqual(selectPackagedRuntimeProcesses([titled], 20, "/tmp/resources", "production"), [
    titled,
  ]);
  assert.throws(
    () =>
      selectPackagedRuntimeProcesses(
        [{ ...titled, exe: "/repo/electron" }],
        20,
        "/tmp/resources",
        "production",
      ),
    /no production runtime/,
  );
  assert.throws(
    () =>
      selectPackagedRuntimeProcesses(
        [{ ...titled, runtimeSelection: "zcode-cli-rust" }],
        20,
        "/tmp/resources",
        "production",
      ),
    /no production runtime/,
  );
  const ts = [{ pid: 21, ppid: 20, cmdline: "/tmp/unpacked/glm/zcode.cjs" }];
  assert.deepEqual(selectPackagedRuntimeProcesses(ts, 20, "/tmp/unpacked", "production"), ts);
  assert.throws(
    () =>
      selectPackagedRuntimeProcesses(
        [...ts, { pid: 22, ppid: 20, cmdline: "/tmp/unpacked/rust/zcode-cli-rust" }],
        20,
        "/tmp/unpacked",
        "production",
      ),
    /overridden/,
  );
});
