// Rust(debug) vs Node(dist) CLI startup/ready/RSS benchmark with reproducible raw JSON.
// Run from the repository root: node scripts/zcode-cli-rust-performance.mjs
// See .agents/specs/cli-rust-performance.md. Reuses the isolated interop helpers without
// modifying them; every measurement gets its own HOME, session DB, workspace and loopback
// model fixture, and the two runtimes alternate start order each round.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  modelServer as startModelServer,
  prepareHome,
  startRuntime,
  stopAllRuntimes,
} from "./zcode-cli-rust-interop-runtime.mjs";

export const REPO_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_BUNDLE = "apps/zcode-cli/packages/cli/dist/zcode.cjs";
const DEFAULT_BINARY = "apps/zcode-cli-rust/target/debug/zcode-cli-rust";
const DEFAULT_OUTPUT = "docs/reports/cli-rust-runtime-handoff-performance.raw.json";
const DEFAULT_ROUNDS = 6;
const MIN_ROUNDS = 5;
const IDLE_MS = 1000;
const NO_PROXY = "127.0.0.1,localhost,::1";
const PROXY_ENV_KEYS = "HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy".split(
  " ",
);
// 脚本只校验 artifact 存在并记录哈希，profile/label 字样来自构建命令声明，未从二进制核验。
const PROFILE_SOURCE = "declared by build command; not verified from artifact";
const LIMITS = [
  "Node 侧是 dist bundle，Rust 侧是 dev (unoptimized + debuginfo) debug 二进制；不是 release 对照。",
  "只覆盖启动到 createSession、subscribe RPC 往返与静置空闲 RSS；不含模型生成、工具执行或稳态吞吐。",
  "每个 runtime 独立初始 DB/HOME，交替启动顺序；样本量有限，未做统计显著性检验。",
  "仅 Linux 实测（/proc/<pid>/status 与 POSIX 进程组清理）；Windows/macOS 未验收。",
  "本地 fail-closed 代理只覆盖读取 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY 的 HTTP 客户端，不是 OS 级网络沙箱，也不阻止直连 socket 或非 HTTP 流量。",
  "fixture 的 requests[] 排除标题 sidecar 请求；nonTitleModelRequests=0 不代表模型侧完全没有任何请求。",
];

/** Median of a non-empty numeric sample; even counts average the two middle values. */
export function median(values) {
  assert(values.length > 0, "median requires at least one sample");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Parses the `VmRSS` line of a Linux `/proc/<pid>/status` snapshot into KiB. */
export function parseVmRssKiB(status) {
  const match = /VmRSS:\s+(\d+)\s+kB/.exec(status);
  assert(match, "VmRSS not found in /proc status");
  return Number(match[1]);
}

/** 1-indexed round to start order; alternates so cache/warmup is not one-runtime-biased. */
export function roundOrder(round) {
  assert(Number.isInteger(round) && round >= 1, "round must be a positive integer");
  return round % 2 === 1 ? ["node", "rust"] : ["rust", "node"];
}

/** True when the path lives inside the repository; drives relative vs basename display. */
function isInRepo(resolvedPath) {
  const relativePath = relative(REPO_ROOT, resolvedPath);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

/** Repo-relative POSIX path for in-repo artifacts; basename only for external artifacts. */
export function artifactDisplayPath(resolvedPath) {
  return isInRepo(resolvedPath)
    ? relative(REPO_ROOT, resolvedPath).split(sep).join("/")
    : basename(resolvedPath);
}

/** `repo-relative` or `external-basename`; external artifacts never leak their directories. */
export function artifactScope(resolvedPath) {
  return isInRepo(resolvedPath) ? "repo-relative" : "external-basename";
}

/** SHA-256 and byte size of the actual artifact on disk. */
export async function hashArtifact(resolvedPath) {
  const data = await readFile(resolvedPath);
  return {
    sha256: createHash("sha256").update(data).digest("hex"),
    sizeBytes: data.byteLength,
  };
}

/**
 * Accurate, non-release build labels for the artifacts actually measured. `--bundle` /
 * `--binary` overrides flow through, so hashes and sizes always describe the real inputs;
 * profile text stays declared-by-build-command rather than an artifact verification.
 */
export async function buildLabels(options = {}) {
  const bundlePath = resolve(REPO_ROOT, options.bundle ?? DEFAULT_BUNDLE);
  const binaryPath = resolve(REPO_ROOT, options.binary ?? DEFAULT_BINARY);
  const [nodeDigest, rustDigest] = await Promise.all([
    hashArtifact(bundlePath),
    hashArtifact(binaryPath),
  ]);
  return {
    node: {
      runtime: "node",
      label: "Node dist",
      artifact: artifactDisplayPath(bundlePath),
      artifactScope: artifactScope(bundlePath),
      sha256: nodeDigest.sha256,
      sizeBytes: nodeDigest.sizeBytes,
      buildCommand: "pnpm --filter @zcode/cli build",
      profile: "dist bundle (esbuild)",
      profileSource: PROFILE_SOURCE,
    },
    rust: {
      runtime: "rust",
      label: "Rust debug",
      artifact: artifactDisplayPath(binaryPath),
      artifactScope: artifactScope(binaryPath),
      sha256: rustDigest.sha256,
      sizeBytes: rustDigest.sizeBytes,
      buildCommand: "pnpm run build:zcode-cli-rust",
      profile: "dev (unoptimized + debuginfo)",
      profileSource: PROFILE_SOURCE,
    },
  };
}

/**
 * Env overlay for the runtimes: point the HTTP proxy variables at the local fail-closed
 * proxy and exempt loopback so the fixture still resolves. This only constrains HTTP
 * clients that read these variables; it is not an OS-level network sandbox.
 */
export function proxyEnvironment(proxyUrl) {
  return Object.fromEntries([
    ...PROXY_ENV_KEYS.map((key) => [key, proxyUrl]),
    ["NO_PROXY", NO_PROXY],
    ["no_proxy", NO_PROXY],
  ]);
}

/** Local HTTP proxy that fails every request closed (502 / socket end). */
export async function startFailClosedProxy() {
  const server = createServer((_request, response) => {
    response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("fail-closed benchmark proxy: outbound HTTP is blocked\n");
  });
  server.on("connect", (_request, socket) => {
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolveClose, reject) => {
        const timer = setTimeout(
          () => reject(new Error("fail-closed proxy close deadline exceeded")),
          5_000,
        );
        server.close((error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolveClose();
        });
      });
    },
  };
}

const SENSITIVE_PATTERNS = [
  /\/home\/[^"\s]+/,
  /\/Users\/[^"\s]+/,
  /[A-Za-z]:\\Users\\/,
  /\/tmp\/[^"\s]+/,
  /\/(?:private\/)?var\/folders\//,
  /sk-[A-Za-z0-9_-]{8,}/,
  /ghp_[A-Za-z0-9]{10,}/,
  /Bearer\s+[A-Za-z0-9._-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Fails if serialized output would leak a home/temp path or a credential-shaped token. */
export function assertNoSensitiveReport(report) {
  const text = JSON.stringify(report);
  for (const pattern of SENSITIVE_PATTERNS) {
    const match = pattern.exec(text);
    assert(!match, `report contains sensitive data: ${match?.[0] ?? pattern}`);
  }
  return report;
}

/** Replaces local home/temp prefixes in free-form error text with placeholders. */
export function sanitize(text) {
  return String(text)
    .replaceAll(os.tmpdir(), "<tmp>")
    .replace(/\/home\/[^/\s"']+/g, "<home>")
    .replace(/\/Users\/[^/\s"']+/g, "<home>");
}

function safeVersion(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unavailable";
  }
}

const roundMs = (value) => Math.round(value * 1000) / 1000;

/**
 * One isolated measurement. `deps` is injectable so tests can force an early failure and
 * assert the temp root is cleaned even when the model fixture never starts.
 */
export async function measureOnce({ kind, bundle, binary, proxyUrl, deps = {} } = {}) {
  const createRoot = deps.createRoot ?? (() => mkdtemp(join(os.tmpdir(), `zcode-perf-${kind}-`)));
  const openModel = deps.openModel ?? startModelServer;
  const prepare = deps.prepareHome ?? prepareHome;
  const start = deps.startRuntime ?? startRuntime;
  let root;
  let model;
  let runtime;
  try {
    root = await createRoot();
    model = await openModel({ root });
    const env = { ...(await prepare(root, model.baseUrl)), ...proxyEnvironment(proxyUrl) };
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const startedAt = performance.now();
    runtime = start(kind, { bundle, binary, cwd, env, dataDir: join(root, "data") });
    const created = await runtime.command("createSession", null, {
      workspaceId: cwd,
      config: { mode: "build" },
    });
    const readyAt = performance.now();
    const sessionId = created?.result?.sessionId;
    assert(sessionId, `${kind}: createSession did not return a sessionId`);
    const subscribeStart = performance.now();
    await runtime.subscribe(sessionId);
    const subscribeEnd = performance.now();
    // 唯一同步边界：subscribe 响应后固定静置，再从 /proc 读取空闲 RSS。
    await new Promise((resolveIdle) => setTimeout(resolveIdle, IDLE_MS));
    const status = await readFile(`/proc/${runtime.child.pid}/status`, "utf8");
    const idleRssKiB = parseVmRssKiB(status);
    // fixture 的 requests[] 排除标题 sidecar；此处只断言 driver 没有发送非标题请求。
    const nonTitleModelRequests = model.requests.length;
    assert.equal(
      nonTitleModelRequests,
      0,
      `${kind}: driver sent no user input but the fixture recorded ${nonTitleModelRequests} non-title request(s)`,
    );
    return {
      startupToReadyMs: roundMs(readyAt - startedAt),
      subscribeRpcMs: roundMs(subscribeEnd - subscribeStart),
      idleRssKiB,
      nonTitleModelRequests,
    };
  } finally {
    const cleanups = [];
    if (runtime) cleanups.push(runtime.close().catch(() => runtime.kill()));
    if (model) cleanups.push(model.close());
    await Promise.allSettled(cleanups);
    if (root) await rm(root, { recursive: true, force: true });
  }
}

async function measureRound({ round, bundle, binary, proxyUrl }) {
  const order = roundOrder(round);
  const measurements = {};
  for (const kind of order)
    measurements[kind] = await measureOnce({ kind, bundle, binary, proxyUrl });
  return { round, order, measurements };
}

function sampleOf(rounds, kind) {
  return rounds.map((round) => round.measurements[kind]).filter(Boolean);
}

function summarize(samples) {
  return {
    startupToReadyMs: median(samples.map((sample) => sample.startupToReadyMs)),
    subscribeRpcMs: median(samples.map((sample) => sample.subscribeRpcMs)),
    idleRssKiB: median(samples.map((sample) => sample.idleRssKiB)),
    sampleCount: samples.length,
  };
}

/** Builds the raw JSON report from measured rounds and verified artifact facts. */
export function buildReport({ rounds, options, builds, proxyUrl }) {
  const nodeSamples = sampleOf(rounds, "node");
  const rustSamples = sampleOf(rounds, "rust");
  const nonTitleModelRequests = rounds.reduce(
    (total, round) =>
      total +
      (round.measurements.node?.nonTitleModelRequests ?? 0) +
      (round.measurements.rust?.nonTitleModelRequests ?? 0),
    0,
  );
  return {
    schemaVersion: 1,
    status: "ok",
    generatedAt: new Date().toISOString(),
    protocol: {
      createSession: "v4/command:createSession",
      subscribe: "v4/conversation/subscribe",
    },
    environment: {
      platform: process.platform,
      kernelRelease: os.release(),
      arch: process.arch,
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      cpuCount: os.cpus().length,
      totalMemoryMiB: Math.round(os.totalmem() / 1024 / 1024),
      nodeVersion: process.version,
      rustcVersion: safeVersion("rustc", ["--version"]),
    },
    builds,
    measurement: {
      startupToReady:
        "performance.now() immediately before startRuntime() until createSession returns result.sessionId",
      subscribe: "runtime.subscribe(sessionId) RPC round trip",
      idleRss: `wait ${IDLE_MS}ms after the subscribe response, then read /proc/<pid>/status VmRSS`,
      isolatePerRuntime: true,
      alternatingStartOrder: true,
      rounds: options.rounds,
      nonTitleModelRequests,
      nonTitleModelRequestsNote:
        "fixture 的 requests[] 排除标题 sidecar 请求；driver 未发送用户输入（无 sendText/turn），此处只统计非标题请求，不代表模型侧完全没有请求。",
      proxy: {
        kind: "local fail-closed HTTP proxy",
        endpoint: proxyUrl,
        appliesTo: PROXY_ENV_KEYS,
        noProxy: NO_PROXY,
        limitation:
          "只约束读取这些环境变量的 HTTP 客户端；不是 OS 级网络沙箱，也不阻止直连 socket 或非 HTTP 流量。",
      },
    },
    rounds: rounds.map((round) => ({
      round: round.round,
      // 标量字符串而非短数组：让生成的 JSON 与仓库 oxfmt 输出稳定一致。
      startOrder: round.order.join("->"),
      measurements: {
        node: round.measurements.node ?? null,
        rust: round.measurements.rust ?? null,
      },
    })),
    medians: { node: summarize(nodeSamples), rust: summarize(rustSamples) },
    limits: LIMITS,
  };
}

function parseArgs(argv) {
  const options = {
    bundle: DEFAULT_BUNDLE,
    binary: DEFAULT_BINARY,
    output: DEFAULT_OUTPUT,
    rounds: DEFAULT_ROUNDS,
  };
  for (const arg of argv) {
    const [flag, value] = arg.split("=");
    if (flag === "--bundle" && value) options.bundle = value;
    else if (flag === "--binary" && value) options.binary = value;
    else if (flag === "--output" && value) options.output = value;
    else if (flag === "--rounds" && value) options.rounds = Number(value);
    else throw new Error(`unknown argument: ${arg}`);
  }
  assert(
    Number.isInteger(options.rounds) && options.rounds >= MIN_ROUNDS,
    `--rounds must be an integer >= ${MIN_ROUNDS}`,
  );
  return options;
}

async function run(options) {
  if (process.platform !== "linux") {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          status: "unsupported_platform",
          platform: process.platform,
          reason: "idle RSS reads /proc/<pid>/status and POSIX process-group cleanup is required",
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }
  assert(
    existsSync(join(REPO_ROOT, "config/provider/zcode-builtin.json")),
    "run from the repository root",
  );
  const bundle = resolve(REPO_ROOT, options.bundle);
  const binary = resolve(REPO_ROOT, options.binary);
  assert(
    existsSync(bundle),
    `missing Node dist bundle: ${options.bundle}; run \`pnpm --filter @zcode/cli build\``,
  );
  assert(
    existsSync(binary),
    `missing Rust debug binary: ${options.binary}; run \`pnpm run build:zcode-cli-rust\``,
  );
  // 记录实际被测文件的哈希/大小，而不是默认路径；标签可据此复核。
  const builds = await buildLabels(options);
  const proxy = await startFailClosedProxy();
  const rounds = [];
  try {
    for (let round = 1; round <= options.rounds; round++) {
      rounds.push(await measureRound({ round, bundle, binary, proxyUrl: proxy.url }));
    }
  } finally {
    await stopAllRuntimes().catch((error) =>
      console.error(`runtime cleanup failed: ${sanitize(String(error))}`),
    );
    await proxy
      .close()
      .catch((error) => console.error(`proxy cleanup failed: ${sanitize(String(error))}`));
  }
  const report = assertNoSensitiveReport(
    buildReport({ rounds, options, builds, proxyUrl: proxy.url }),
  );
  const output = resolve(REPO_ROOT, options.output);
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

export async function main(argv = process.argv.slice(2)) {
  try {
    await run(parseArgs(argv));
  } catch (error) {
    process.exitCode = 1;
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          status: "failed",
          reason: sanitize(error instanceof Error ? error.message : String(error)),
        },
        null,
        2,
      ),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
