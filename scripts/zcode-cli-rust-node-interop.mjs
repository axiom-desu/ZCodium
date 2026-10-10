// Run from the repository root with: env -u TSX_TSCONFIG_PATH node --import tsx scripts/zcode-cli-rust-node-interop.mjs.
// Cross-runtime acceptance (spec rust-m11-node-storage §11 scenarios 4–6) with the real
// Node CLI (`zcode.cjs`) and the Rust binary over one session database:
//   4. Node and Rust continue one session in turn (text and tool turns);
//   5. either runtime is killed while streaming or running a tool; the other resumes it
//      interrupted and answers the queued command as discarded;
//   6. both processes write their own sessions at the same time.
// After each scenario Node's readers and Rust's cold reading are compared session by session.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { compareDatabase } from "./zcode-cli-rust-node-compare.mjs";
import { hasAssistantTextEvidence } from "./lib/zcode-cli-rust-stream-evidence.mjs";
import {
  modelServer,
  prepareHome,
  startRuntime,
  stopAllRuntimes,
  transcript,
} from "./zcode-cli-rust-interop-runtime.mjs";

const bundle = resolve(process.argv[2] ?? "apps/zcode-cli/packages/cli/dist/zcode.cjs");
const binary = resolve(process.argv[3] ?? "apps/zcode-cli-rust/target/release/zcode-cli-rust");
const reader = resolve(process.argv[4] ?? "apps/zcode-cli-rust/target/release/examples/node_read");
const globalDeadline = setTimeout(() => {
  process.exitCode = 1;
  console.error(
    JSON.stringify({ status: "failed", category: "global-deadline", timeoutMs: 600_000 }),
  );
  void stopAllRuntimes().catch((error) => console.error(String(error)));
}, 600_000);

async function scenario(name, run) {
  const root = await mkdtemp(join(tmpdir(), `zcode-interop-${name}-`));
  const model = await modelServer({ root });
  try {
    const env = await prepareHome(root, model.baseUrl);
    const workspace = async (label) => {
      const cwd = join(root, label);
      await mkdir(cwd, { recursive: true });
      await writeFile(join(cwd, "note.txt"), "interop note\n");
      return cwd;
    };
    const start = (kind, cwd) =>
      startRuntime(kind, { bundle, binary, cwd, env, dataDir: join(root, "rust-data") });
    try {
      const result = await run({ start, workspace, model, root });
      await stopAllRuntimes();
      const compared = await compareDatabase(
        join(root, "db.sqlite"),
        join(env.ZCODE_STORAGE_DIR, "cli/artifacts"),
        reader,
      );
      const equal =
        compared.equal === compared.read && !compared.rustFailed && !compared.nodeFailed;
      const casesPassed =
        !result.cases || Object.values(result.cases).every((test) => test.status === "passed");
      console.log(
        JSON.stringify({
          scenario: name,
          ...result,
          status: !casesPassed ? "failed" : equal ? "passed" : "database-difference",
          database: {
            sessions: compared.sessions,
            read: compared.read,
            equal: compared.equal,
            coldReadMs: compared.coldReadMs,
            rustFailed: compared.rustFailed,
            nodeFailed: compared.nodeFailed,
            mismatches: compared.mismatches,
            sourceFilesUnchanged: compared.sourceFilesUnchanged,
            sourceHashes: compared.sourceHashes,
          },
        }),
      );
      if (!equal) process.exitCode = 1;
    } catch (error) {
      process.exitCode = 1;
      console.log(JSON.stringify({ scenario: name, status: "failed", error: String(error) }));
    }
  } finally {
    try {
      await stopAllRuntimes();
    } catch (error) {
      process.exitCode = 1;
      console.error(`runtime cleanup failed: ${String(error)}`);
    }
    try {
      await model.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

/** The model request of the latest turn as `role:text` entries. */
const lastTranscript = (model) => transcript(model.requests.at(-1));

async function waitForShellHandshake(runtime, from, path, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    runtime.assertHealthy();
    if (
      runtime.diagnosticFrames.some(
        (frame) =>
          frame.method === "v4/command:resolveInteraction" &&
          frame.toolName === "Bash" &&
          frame.result?.status === "accepted",
      )
    )
      break;
    const permissionFailure = runtime.diagnosticFrames.find((frame) => {
      const payload = frame.params?.frame?.payload ?? frame.params ?? {};
      const outcome = [
        payload.status,
        payload.result?.status,
        payload.decision,
        payload.result?.decision,
      ]
        .filter((value) => typeof value === "string")
        .join(" ");
      return /denied|rejected|blocked/i.test(outcome);
    });
    if (permissionFailure) {
      const payload = permissionFailure.params?.frame?.payload ?? permissionFailure.params ?? {};
      const status = payload.status ?? payload.result?.status ?? "unknown";
      const decision = payload.decision ?? payload.result?.decision ?? "unknown";
      const errorPath = payload.error ? "present" : "absent";
      throw new Error(
        `Bash permission denied before pid handshake: method=${permissionFailure.method ?? "rpc-ack"}, status=${status}, decision=${decision}, errorPath=${errorPath}`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  if (
    !runtime.diagnosticFrames.some(
      (frame) =>
        frame.method === "v4/command:resolveInteraction" &&
        frame.toolName === "Bash" &&
        frame.result?.status === "accepted",
    )
  )
    throw new Error("Bash PID handshake was not preceded by an accepted V4 permission ACK");
  const pidStarted = Date.now();
  while (Date.now() - pidStarted < timeoutMs) {
    runtime.assertHealthy();
    const contents = await readFile(path, "utf8").catch(() => "");
    if (contents.trim()) return contents;
    const tools = runtime.deltas(from).filter((delta) => delta.row?.kind === "toolCall");
    const terminal = tools.find((delta) =>
      ["success", "error", "cancelled"].includes(delta.row.status),
    );
    if (terminal)
      throw new Error(
        `Bash terminal before pid handshake: status=${terminal.row.status}, errorPath=${terminal.row.error ? "present" : "absent"}`,
      );
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`fixture shell did not write its pid handshake: ${path}`);
}

async function verifyCrashRecovery({ start, resumer, cwd, id, queued }) {
  const runtime = start(resumer, cwd);
  try {
    await runtime.subscribe(id);
    const snapshot = await runtime.snapshot();
    const open = snapshot.rows.window.filter(
      (row) =>
        ["running", "streaming"].includes(row.state) ||
        ["running", "inputStreaming", "pendingApproval"].includes(row.status),
    );
    assert.deepEqual(open, [], `${resumer} resumed with open rows`);
    assert(!["running", "prewarming"].includes(snapshot.control.phase), snapshot.control.phase);
    const replay = await runtime.command("sendText", id, { text: "queued input" }, queued);
    assert.equal(
      replay.reasonCode,
      "fault.command.inputDiscardedOnRestart",
      JSON.stringify(replay),
    );
    await runtime.turn(id, "after crash");
  } finally {
    await runtime.close();
  }
}

if (process.platform === "win32") {
  process.exitCode = 1;
  console.log(
    JSON.stringify({
      status: "unsupported_platform",
      platform: process.platform,
      reason: "interop fixture requires POSIX Bash/sleep and process-group cleanup",
    }),
  );
  clearTimeout(globalDeadline);
} else {
  // 场景 4：Node 与 Rust 交替续写同一会话（含工具轮）。
  await scenario("alternate", async ({ start, workspace, model }) => {
    const cwd = await workspace("ws");
    const node = start("node", cwd);
    const created = await node.command("createSession", null, {
      workspaceId: cwd,
      config: { mode: "build" },
    });
    assert(created.result?.sessionId, JSON.stringify(created));
    const id = created.result.sessionId;
    await node.subscribe(id);
    await node.turn(id, "turn 1 from node");
    await node.turn(id, "use tool on note");
    await node.close();
    const steps = [];
    const sent = ["turn 1 from node", "use tool on note"];
    for (const [kind, text] of [
      ["rust", "turn 2 from rust"],
      ["node", "turn 3 from node"],
      ["rust", "turn 4 from rust"],
    ]) {
      const runtime = start(kind, cwd);
      await runtime.subscribe(id);
      await runtime.turn(id, text);
      sent.push(text);
      steps.push(kind);
      await runtime.close();
      // 请求里的对话是此前所有运行时写入的完整历史（含对方的工具调用与结果）。
      const seen = lastTranscript(model);
      assert.deepEqual(
        seen.filter((e) => e.startsWith("user:")),
        sent.map((t) => `user:${t}`),
        `${kind} request: ${seen.join(" | ")}`,
      );
      assert(seen.includes("call:Read") && seen.includes("tool:result"), seen.join(" | "));
    }
    const permissionAcks = node.diagnosticFrames.filter(
      (frame) =>
        frame.method === "v4/command:resolveInteraction" ||
        frame.method === "interaction/requestPermission",
    );
    return { turns: 5, runtimes: ["node", ...steps], permissionAcks };
  });

  // 场景 5：流式中与工具执行中强杀，另一个运行时恢复；排队命令按重启丢弃回答。
  await scenario("crash", async ({ start, workspace, root, model }) => {
    const cwd = await workspace("ws");
    const results = {};
    const cases = [
      ["rust", "node", "slow stream"],
      ["node", "rust", "slow stream"],
      ["rust", "node", "shell please"],
      ["node", "rust", "shell please"],
    ];
    for (const [killed, resumer, prompt] of cases) {
      const label = `${killed}:${prompt.startsWith("slow") ? "stream" : "tool"}`;
      const victim = start(killed, cwd);
      let stage = "driver-setup";
      const pidFile = join(
        root,
        "ws",
        `${killed}-${prompt.startsWith("slow") ? "stream" : "tool"}.pid`,
      );
      try {
        assert.equal(resolve(cwd), cwd, "workspace cwd must be absolute");
        assert.equal(victim.environment.HOME, join(root, "home"));
        assert.equal(victim.environment.ZCODE_SESSION_DB_PATH, join(root, "db.sqlite"));
        assert.equal(victim.environment.ZCODE_STORAGE_DIR, join(root, "storage"));
        assert(
          victim.child.spawnargs.includes(cwd),
          `${killed} did not receive shared workspace cwd`,
        );
        assert(!Object.keys(victim.environment).some((key) => /TOKEN|API_KEY|PROXY/i.test(key)));
        const created = await victim.command("createSession", null, {
          workspaceId: cwd,
          config: { mode: "build" },
        });
        const id = created.result?.sessionId;
        assert(id, `${killed} createSession failed: ${JSON.stringify(created)}`);
        await victim.subscribe(id);
        stage = "runtime-turn-setup";
        await victim.turn(id, "before crash");
        const from = victim.frames.length;
        const crashPrompt = prompt.startsWith("shell") ? "shell please" : prompt;
        if (prompt.startsWith("shell")) model.setShellPidFile(pidFile);
        stage = prompt.startsWith("shell") ? "tool-execution-handshake" : "stream-handshake";
        const previousSlowSignalCount = prompt.startsWith("slow")
          ? model.slowChunkCount(crashPrompt)
          : 0;
        const sendAck = await victim.command("sendText", id, { text: crashPrompt });
        assert.equal(
          sendAck.status,
          "accepted",
          `${killed} sendText ack: ${JSON.stringify(sendAck)}`,
        );
        let shellPid;
        if (prompt.startsWith("slow")) {
          await Promise.all([
            model.waitForSlowChunk(crashPrompt, previousSlowSignalCount, 20_000),
            victim.until(() => hasAssistantTextEvidence(victim.frames, from, id), from, 20_000),
          ]);
        } else {
          // toolCall running 仅用于诊断；只有真实 PID 文件握手才允许进入 kill 阶段。
          const pidContents = await waitForShellHandshake(victim, from, pidFile, 20_000);
          shellPid = Number(pidContents.trim());
          assert(
            Number.isSafeInteger(shellPid) && shellPid > 1,
            `invalid fixture shell pid: ${JSON.stringify(pidContents)}`,
          );
        }
        stage = "queue-and-kill";
        const queued = randomUUID();
        const ack = await victim.command("sendText", id, { text: "queued input" }, queued);
        assert.equal(ack.result?.delivery, "queue", JSON.stringify(ack));
        await victim.kill();
        if (shellPid) {
          try {
            process.kill(shellPid, "SIGKILL");
          } catch {
            /* shell may already have exited */
          }
          await rm(pidFile, { force: true });
        }
        stage = "resume-and-compare";
        await verifyCrashRecovery({ start, resumer, cwd, id, queued });
        results[label] = {
          status: "passed",
          killed,
          resumer,
          shellPidHandshake: Boolean(shellPid),
          permissionAcks: victim.diagnosticFrames
            .filter(
              (frame) =>
                frame.method === "interaction/requestPermission" ||
                frame.method === "v4/command:resolveInteraction",
            )
            .map((frame) => ({
              method: frame.method,
              decision: frame.decision ?? frame.result?.status ?? "unknown",
              interactionId: frame.interactionId,
              toolName: frame.toolName,
            })),
        };
      } catch (error) {
        process.exitCode = 1;
        const category =
          stage === "driver-setup" || stage === "runtime-turn-setup"
            ? "driver-setup"
            : "待核实：driver V4 answer / runtime 行为";
        results[label] = { status: "failed", category, stage, reason: String(error) };
        console.log(
          JSON.stringify({
            scenario: "crash-case",
            case: label,
            category,
            stage,
            terminalPermissionEvents: victim.diagnosticFrames.map((frame) => {
              const payload = frame.params?.frame?.payload ?? frame.params ?? {};
              const row = payload.row ?? payload;
              const deltas = (payload.deltas ?? []).map((delta) => {
                const toolRow = delta.row ?? {};
                return {
                  kind: toolRow.kind ?? delta.kind ?? "unknown",
                  status: toolRow.status ?? "unknown",
                  errorPath: toolRow.error ? "present" : "absent",
                  errorCode: toolRow.error?.code ?? "unknown",
                };
              });
              return {
                method: frame.method ?? "rpc-ack",
                status: row.status ?? payload.status ?? "unknown",
                phase: payload.phase ?? "unknown",
                resultType: payload.resultType ?? "unknown",
                decision: row.decision ?? payload.decision ?? "unknown",
                errorPath: row.error || payload.error ? "present" : "absent",
                errorCode: row.error?.code ?? payload.error?.code ?? "unknown",
                deltas,
              };
            }),
            stderr: victim.stderr.slice(-4000),
          }),
        );
      } finally {
        await victim.kill();
        await rm(pidFile, { force: true });
      }
    }
    return { cases: results };
  });

  // 场景 6：Node 与 Rust 同时写各自的会话。
  await scenario("concurrent", async ({ start, workspace }) => {
    const turns = 12;
    const runs = await Promise.all(
      ["node", "rust"].map(async (kind) => {
        const cwd = await workspace(`ws-${kind}`);
        const runtime = start(kind, cwd);
        const id = (
          await runtime.command("createSession", null, {
            workspaceId: cwd,
            config: { mode: "build" },
          })
        ).result.sessionId;
        await runtime.subscribe(id);
        for (let i = 0; i < turns; i++) await runtime.turn(id, `${kind} turn ${i}`);
        await runtime.close();
        assert.doesNotMatch(runtime.stderr, /database is locked|SQLITE_BUSY/i);
        return kind;
      }),
    );
    return { runtimes: runs, turnsEach: turns };
  });
  clearTimeout(globalDeadline);
}
