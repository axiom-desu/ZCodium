// M8 Desktop 存储准备 transport 夹具：同一个脚本同时作为 Node Worker 与 native child 运行。
// 仅用于测试，按 STORAGE_PREP_MODE 覆盖成功与异常握手分支，不访问真实用户库。
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const MODE = process.env.STORAGE_PREP_MODE ?? "ok";
const cwdFlag = process.argv.indexOf("--cwd");
const cwd = cwdFlag >= 0 && process.argv[cwdFlag + 1] ? process.argv[cwdFlag + 1] : process.cwd();
const path = process.env.STORAGE_PREP_PATH ?? `${cwd}/.zcode-session.db`;

// native 分支用它证明 Host abort 后进程确实退出，而不是留下持锁孤儿。
if (process.env.STORAGE_PREP_PID_LOG) {
  writeFileSync(process.env.STORAGE_PREP_PID_LOG, String(process.pid));
}

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const state = (phase, extra = {}) => ({
  method: "startup/storageState",
  params: {
    schemaVersion: 1,
    attemptId: "fixture",
    sequence: 1,
    databaseId: "session",
    databaseKind: "session",
    phase,
    elapsedMs: 1,
    ...extra,
  },
});
const hold = () => setInterval(() => {}, 1_000);
const finish = (frames, code) => {
  const payload = `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`;
  // 等 stdout 写回调再退出，避免管道缓冲里的控制帧被截断。
  process.stdout.write(payload, () => process.exit(code));
};

if (MODE === "prepared-first") send({ method: "startup/storagePrepared", params: {} });
else if (MODE === "duplicate-path") {
  send({ method: "startup/storagePath", params: { path } });
  send({ method: "startup/storagePath", params: { path } });
} else send({ method: "startup/storagePath", params: { path } });

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  if (frame.method !== "startup/storagePathReady") return;
  if (process.env.STORAGE_PREP_READY_LOG) {
    writeFileSync(process.env.STORAGE_PREP_READY_LOG, JSON.stringify(frame));
  }
  if (MODE === "invalid") {
    process.stdout.write("not-json\n");
    hold();
  } else if (MODE === "hold") {
    send(state("ready"));
    hold();
  } else if (MODE === "failed") {
    finish([state("failed", { errorCode: "open_failed" })], 0);
  } else if (MODE === "prepared-first" || MODE === "duplicate-path") {
    hold();
  } else if (MODE === "no-prepared") {
    process.exit(0);
  } else if (MODE === "nonzero") {
    finish([state("ready"), { method: "startup/storagePrepared", params: {} }], 1);
  } else {
    finish([state("ready"), { method: "startup/storagePrepared", params: {} }], 0);
  }
});
