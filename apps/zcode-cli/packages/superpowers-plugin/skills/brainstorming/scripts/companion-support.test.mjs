import assert from "node:assert/strict";
import test from "node:test";
import server from "./server.cjs";
import protocol from "./websocket-protocol.cjs";
import support from "./companion-support.cjs";

const { OPCODES, MAX_FRAME_PAYLOAD_BYTES, computeAcceptKey, encodeFrame, decodeFrame } = protocol;

test("websocket handshake and frames retain RFC 6455 behavior", () => {
  assert.equal(computeAcceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  assert.equal(MAX_FRAME_PAYLOAD_BYTES, 10 * 1024 * 1024);

  const textFrame = encodeFrame(OPCODES.TEXT, Buffer.from("hi"));
  assert.equal(textFrame[0], 0x81);
  assert.equal(textFrame[1], 2);

  const payload = Buffer.from("hi");
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
  const decoded = decodeFrame(
    Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]),
  );
  assert.equal(decoded.opcode, OPCODES.TEXT);
  assert.equal(decoded.payload.toString(), "hi");
  assert.equal(decoded.bytesConsumed, 8);
});

test("request authorization accepts query key and cookie but rejects others", () => {
  const token = "a".repeat(32);
  const authorized = support.isAuthorized(
    { url: `/?key=${token}`, headers: {} },
    token,
    "brainstorm-key-1",
  );
  const cookieAuthorized = support.isAuthorized(
    { url: "/", headers: { cookie: `brainstorm-key-1=${token}` } },
    token,
    "brainstorm-key-1",
  );
  const rejected = support.isAuthorized(
    { url: "/?key=nope", headers: {} },
    token,
    "brainstorm-key-1",
  );

  assert.equal(authorized, true);
  assert.equal(cookieAuthorized, true);
  assert.equal(rejected, false);
});

test("browser launcher stays a pure platform decision", () => {
  assert.deepEqual(
    support.browserLauncherForPlatform("http://localhost:1", { platform: "darwin" }),
    { bin: "open", args: ["http://localhost:1"] },
  );
  assert.deepEqual(
    support.browserLauncherForPlatform("http://localhost:1", {
      platform: "linux",
      osRelease: "5.15.0-microsoft-standard-WSL2",
      env: {},
    }),
    { bin: "rundll32.exe", args: ["url.dll,FileProtocolHandler", "http://localhost:1"] },
  );
  assert.equal(
    support.browserLauncherForPlatform("http://localhost:1", {
      platform: "linux",
      osRelease: "6.0",
      env: {},
    }),
    null,
  );
});

test("server keeps its public CommonJS export surface", () => {
  assert.equal(server.computeAcceptKey, computeAcceptKey);
  assert.equal(server.encodeFrame, encodeFrame);
  assert.equal(server.decodeFrame, decodeFrame);
  assert.equal(server.browserLauncherForPlatform, support.browserLauncherForPlatform);
  assert.equal(server.OPCODES, OPCODES);
  assert.equal(server.MAX_FRAME_PAYLOAD_BYTES, MAX_FRAME_PAYLOAD_BYTES);
});

test("server imports every shared helper it references", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./server.cjs", import.meta.url), "utf8");

  // server.cjs 从这里抽取 helper 后，漏一个解构不会在语法/类型层暴露，
  // 只会在该分支真正执行时抛 ReferenceError（首页 ?key= 校验就这样静默 500 过）。
  const destructured = new Set();
  for (const block of source.matchAll(
    /const \{([\s\S]*?)\} = require\(["']\.\/([\w-]+\.cjs)["']\);/g,
  )) {
    for (const name of block[1].split(/[,\s]+/)) if (name) destructured.add(name);
  }
  const withoutRequires = source.replace(/const \{[\s\S]*?\} = require\(["'][^"']+["']\);/g, "");

  for (const module of [support, protocol]) {
    for (const name of Object.keys(module)) {
      if (!new RegExp(`\\b${name}\\b`).test(withoutRequires)) continue;
      assert.ok(destructured.has(name), `server.cjs references ${name} but never destructures it`);
    }
  }
});
