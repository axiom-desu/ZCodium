/**
 * `compatible/helper-client.js` 单测：用假进程验证 JSON-lines 协议与监督。
 *
 * 真 helper 是 GJS（仅 GNOME 环境可用），此处注入假 `spawn`，不依赖 gjs/D-Bus。
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createHelperClient } from "../compatible/helper-client.js";

function makeProcess({ respond = true } = {}) {
  const stdout = new EventEmitter();
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter();
  stderr.setEncoding = () => {};
  const proc = new EventEmitter();
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.writes = [];
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
  };
  proc.stdin = {
    write(line) {
      proc.writes.push(line);
      const request = JSON.parse(line);
      if (request.method === "shutdown") {
        queueMicrotask(() => proc.emit("exit", 0));
      } else if (respond) {
        queueMicrotask(() =>
          stdout.emit(
            "data",
            `${JSON.stringify({ id: request.id, ok: true, result: { method: request.method } })}\n`,
          ),
        );
      }
      return true;
    },
  };
  return proc;
}

function spawnWith(proc) {
  return () => {
    queueMicrotask(() => proc.stdout.emit("data", '{"event":"ready","version":8}\n'));
    return proc;
  };
}

test("请求按 id 匹配并 resolve，ready 事件被忽略", async () => {
  const proc = makeProcess();
  const client = createHelperClient({ spawn: spawnWith(proc) });
  assert.deepEqual(await client.request("ping"), { method: "ping" });
  assert.deepEqual(await client.request("version"), { method: "version" });
  assert.equal(proc.writes.length, 2);
  assert.equal(client.running, true);
  await client.dispose();
  assert.equal(client.running, false);
});

test("跨 chunk 的半行也能正确拼接", async () => {
  const proc = makeProcess({ respond: false });
  const client = createHelperClient({ spawn: spawnWith(proc) });
  const pending = client.request("x");
  proc.stdout.emit("data", '{"id":1,"ok":true,"res');
  proc.stdout.emit("data", 'ult":{"a":1}}\n');
  assert.deepEqual(await pending, { a: 1 });
});

test("helper 报错时 reject", async () => {
  const proc = makeProcess({ respond: false });
  const client = createHelperClient({ spawn: spawnWith(proc) });
  const pending = client.request("x");
  proc.stdout.emit("data", '{"id":1,"ok":false,"error":"boom"}\n');
  await assert.rejects(pending, /boom/);
});

test("helper 退出时挂起请求被拒绝，并带上 stderr", async () => {
  const proc = makeProcess({ respond: false });
  const client = createHelperClient({ spawn: spawnWith(proc) });
  const pending = client.request("slow");
  proc.stderr.emit("data", "helper crashed\n");
  proc.emit("exit", 1);
  await assert.rejects(pending, /helper crashed/);
});

test("dispose 发送 shutdown，之后请求被拒绝", async () => {
  const proc = makeProcess();
  const client = createHelperClient({ spawn: spawnWith(proc) });
  await client.request("ping");
  await client.dispose();
  assert.ok(proc.writes.some((line) => line.includes('"shutdown"')));
  await assert.rejects(() => client.request("ping"), /disposed/);
});
