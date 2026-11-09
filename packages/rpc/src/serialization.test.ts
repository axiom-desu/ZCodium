/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { Buffer as NodeBuffer } from "node:buffer";
import { VSBuffer } from "./buffer.js";
import { ChannelClient } from "./channelClient.js";
import { ChannelServer } from "./channelServer.js";
import type { IChannel } from "./channels.shared.js";
import { Emitter, Event } from "./foundation.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "./serialization.js";

function roundTrip(value: unknown): unknown {
  const writer = new BufferWriter();
  serialize(writer, value);
  return { encoded: writer.buffer, decoded: deserialize(new BufferReader(writer.buffer)) };
}

describe("RPC 嵌套二进制序列化", () => {
  it("对象里的 Node Buffer 往返后仍是二进制而不是数字数组", () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255]);
    const payload = {
      archive: NodeBuffer.from(bytes),
      entries: [{ name: "a", chunk: NodeBuffer.from([9, 8, 7]) }],
    };

    const { encoded, decoded } = roundTrip(payload) as {
      encoded: { byteLength: number };
      decoded: { archive: Uint8Array; entries: { name: string; chunk: Uint8Array }[] };
    };

    // Bug 现象：Buffer 先被 toJSON 成 {type:"Buffer",data:[...]}，接收端拿到普通对象。
    expect(decoded.archive).toBeInstanceOf(Uint8Array);
    expect(decoded.archive).not.toBeInstanceOf(NodeBuffer);
    expect(Array.from(decoded.archive)).toEqual(Array.from(bytes));
    expect(decoded.archive.byteLength).toBe(bytes.byteLength);
    expect(Array.from(decoded.entries[0].chunk)).toEqual([9, 8, 7]);
    // base64 + 标记远小于逐字节数字数组。
    expect(encoded.byteLength).toBeLessThan(bytes.byteLength * 4 + 200);
    expect(JSON.stringify(decoded)).not.toContain('"type":"Buffer"');
  });

  it("大 Buffer 用 base64 而非膨胀的逐字节 JSON 数组", () => {
    const archive = NodeBuffer.alloc(16 * 1024, 255);
    const { encoded, decoded } = roundTrip({ archive }) as {
      encoded: VSBuffer;
      decoded: { archive: Uint8Array };
    };
    expect(encoded.byteLength).toBeLessThan(archive.byteLength * 2);
    expect(NodeBuffer.from(decoded.archive).equals(archive)).toBe(true);
  });

  it("数组里的 Buffer 与顶层 Uint8Array 都按二进制传递", () => {
    const { decoded } = roundTrip({
      chunks: [NodeBuffer.from([1, 2]), Uint8Array.from([3, 4])],
    }) as { decoded: { chunks: Uint8Array[] } };

    expect(decoded.chunks.map((chunk) => Array.from(chunk))).toEqual([
      [1, 2],
      [3, 4],
    ]);

    const topLevel = roundTrip(Uint8Array.from([5, 6])) as { decoded: Uint8Array };
    expect(Array.from(new Uint8Array(topLevel.decoded))).toEqual([5, 6]);
  });

  it("经真实 RPC 往返保持字节一致", async () => {
    const toClient = new Emitter<VSBuffer>();
    const toServer = new Emitter<VSBuffer>();
    const client = new ChannelClient({ onMessage: toClient.event, send: (b) => toServer.fire(b) });
    const server = new ChannelServer(
      { onMessage: toServer.event, send: (b) => toClient.fire(b) },
      "host",
    );

    const payload = NodeBuffer.from(Array.from({ length: 64 }, (_value, index) => index));
    server.registerChannel("archive", {
      call: async <T>(_ctx: string, _command: string, arg?: unknown) =>
        ({ echo: (arg as { archive: Uint8Array }).archive }) as T,
      listen: () => Event.None,
    });

    const result = (await client
      .getChannel<IChannel>("archive")
      .call("ping", { archive: payload })) as {
      echo: Uint8Array;
    };
    expect(result.echo).toBeInstanceOf(Uint8Array);
    expect(NodeBuffer.from(result.echo).equals(payload)).toBe(true);

    client.dispose();
    server.dispose();
    toClient.dispose();
    toServer.dispose();
  });
});
