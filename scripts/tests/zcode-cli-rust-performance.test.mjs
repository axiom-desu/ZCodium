import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  REPO_ROOT,
  artifactDisplayPath,
  assertNoSensitiveReport,
  buildLabels,
  buildReport,
  median,
  measureOnce,
  parseVmRssKiB,
  proxyEnvironment,
  roundOrder,
  sanitize,
  startFailClosedProxy,
} from "../zcode-cli-rust-performance.mjs";

test("median handles odd, even and single samples and rejects empty input", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([7]), 7);
  assert.throws(() => median([]), /at least one sample/);
});

test("parseVmRssKiB reads VmRSS from a /proc status snapshot", () => {
  const status = "Name:\tzcode-cli-rust\nVmPeak:\t  123456 kB\nVmRSS:\t   57428 kB\n";
  assert.equal(parseVmRssKiB(status), 57428);
  assert.throws(() => parseVmRssKiB("Name:\tmissing\n"), /VmRSS not found/);
});

test("roundOrder alternates start order and covers both runtimes for >= 5 rounds", () => {
  const orders = Array.from({ length: 6 }, (_, index) => roundOrder(index + 1));
  assert.deepEqual(orders[0], ["node", "rust"]);
  assert.deepEqual(orders[1], ["rust", "node"]);
  assert.deepEqual(orders[2], ["node", "rust"]);
  for (const order of orders)
    assert.deepEqual([...order].sort(), ["node", "rust"], "each round runs both runtimes once");
  assert.throws(() => roundOrder(0), /positive integer/);
});

test("artifactDisplayPath keeps repo paths relative and external paths to a basename", () => {
  assert.equal(
    artifactDisplayPath(join(REPO_ROOT, "apps/zcode-cli/packages/cli/dist/zcode.cjs")),
    "apps/zcode-cli/packages/cli/dist/zcode.cjs",
  );
  assert.equal(artifactDisplayPath(join(REPO_ROOT, "target/debug/app")), "target/debug/app");
  assert.equal(artifactDisplayPath("/opt/private/builds/zcode-cli-rust"), "zcode-cli-rust");
  assert.equal(artifactDisplayPath(join(tmpdir(), "elsewhere", "thing")), "thing");
});

test("buildLabels hashes the overridden artifacts and hides external absolute paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-perf-labels-"));
  try {
    const bundlePath = join(root, "custom-bundle.cjs");
    const binaryPath = join(root, "custom-binary");
    const bundleText = "console.log('bundle');\n";
    const binaryText = "not-really-a-binary";
    await writeFile(bundlePath, bundleText);
    await writeFile(binaryPath, binaryText);

    const labels = await buildLabels({ bundle: bundlePath, binary: binaryPath });
    const serialized = JSON.stringify(labels);

    assert.equal(labels.node.artifact, "custom-bundle.cjs");
    assert.equal(labels.node.artifactScope, "external-basename");
    assert.equal(
      labels.node.sha256,
      createHash("sha256").update(bundleText).digest("hex"),
      "node sha256 must come from --bundle, not the default artifact",
    );
    assert.equal(labels.node.sizeBytes, Buffer.byteLength(bundleText));
    assert.equal(labels.rust.artifact, "custom-binary");
    assert.equal(labels.rust.artifactScope, "external-basename");
    assert.equal(
      labels.rust.sha256,
      createHash("sha256").update(binaryText).digest("hex"),
      "rust sha256 must come from --binary, not the default artifact",
    );
    assert.equal(labels.rust.sizeBytes, Buffer.byteLength(binaryText));

    assert.ok(!serialized.includes(root), "external absolute path must not appear in labels");
    assert.match(labels.rust.profile, /debuginfo/);
    assert.doesNotMatch(serialized, /release/i);
    assert.equal(
      labels.rust.profileSource,
      "declared by build command; not verified from artifact",
    );
    assert.equal(labels.node.profileSource, labels.rust.profileSource);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("proxyEnvironment points HTTP proxy variables at the local guard and exempts loopback", () => {
  const env = proxyEnvironment("http://127.0.0.1:45678");
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    assert.equal(env[key], "http://127.0.0.1:45678");
  }
  assert.equal(env.NO_PROXY, env.no_proxy);
  assert.match(env.NO_PROXY, /127\.0\.0\.1/);
  assert.match(env.NO_PROXY, /localhost/);
});

test("startFailClosedProxy fails HTTP requests closed and closes cleanly", async () => {
  const proxy = await startFailClosedProxy();
  try {
    assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(proxy.url);
    assert.equal(response.status, 502);
    await response.text();
  } finally {
    await proxy.close();
  }
});

test("measureOnce removes the temp root when the model fixture fails to start", async () => {
  let root;
  await assert.rejects(
    measureOnce({
      kind: "node",
      deps: {
        createRoot: async () => {
          root = await mkdtemp(join(tmpdir(), "zcode-perf-failure-"));
          return root;
        },
        openModel: async () => {
          throw new Error("fixture boom");
        },
      },
    }),
    /fixture boom/,
  );
  assert.ok(root, "expected createRoot to run before the failure");
  await assert.rejects(readFile(join(root, "home")), /ENOENT/);
});

test("buildReport reports non-title fixture requests without claiming zero model input", () => {
  const sample = {
    startupToReadyMs: 1,
    subscribeRpcMs: 1,
    idleRssKiB: 1,
    nonTitleModelRequests: 0,
  };
  const report = buildReport({
    rounds: [{ round: 1, order: ["node", "rust"], measurements: { node: sample, rust: sample } }],
    options: { rounds: 1 },
    builds: {},
    proxyUrl: "http://127.0.0.1:1",
  });
  assert.equal(report.measurement.nonTitleModelRequests, 0);
  assert.ok(report.measurement.nonTitleModelRequestsNote);
  assert.equal(Object.hasOwn(report.measurement, "modelInputsSent"), false);
  assert.match(report.measurement.proxy.kind, /fail-closed/);
  assert.ok(!report.measurement.proxy.endpoint.includes("0.0.0.0"));
});

test("assertNoSensitiveReport accepts a clean report and rejects leaked paths or tokens", () => {
  const clean = {
    status: "ok",
    artifact: "apps/zcode-cli-rust/target/debug/zcode-cli-rust",
    environment: { kernelRelease: "6.14.0", cpuModel: "Example CPU" },
  };
  assert.equal(assertNoSensitiveReport(clean), clean);
  assert.throws(
    () => assertNoSensitiveReport({ ...clean, home: "/home/example/.zcodium" }),
    /sensitive/,
  );
  assert.throws(
    () => assertNoSensitiveReport({ ...clean, root: "/tmp/zcode-perf-node-abc" }),
    /sensitive/,
  );
  assert.throws(
    () => assertNoSensitiveReport({ ...clean, token: "sk-abcdefghijklmnop" }),
    /sensitive/,
  );
});

test("sanitize replaces local home and temp prefixes", () => {
  const text = `failed under ${tmpdir()}/zcode-perf-rust-x and /home/example/.zcodium`;
  const safe = sanitize(text);
  assert.doesNotMatch(safe, new RegExp(tmpdir()));
  assert.doesNotMatch(safe, /\/home\/example/);
  assert.match(safe, /<tmp>\/zcode-perf-rust-x/);
  assert.match(safe, /<home>\/\.zcodium/);
});
