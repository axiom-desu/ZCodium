import { expect, it } from "vitest";
import { ChannelClient } from "./channelClient.js";
import { ChannelServer } from "./channelServer.js";
import { Emitter } from "./foundation.js";
import type { VSBuffer } from "./buffer.js";

for (const advertised of [undefined, { mobileProjectDirectory: true as const }]) {
  it(`Initialize optional capability: ${advertised ? "guarded attachment" : "old peer"}`, async () => {
    const toClient = new Emitter<VSBuffer>();
    const toServer = new Emitter<VSBuffer>();
    const client = new ChannelClient({
      onMessage: toClient.event,
      send: (buffer) => toServer.fire(buffer),
    });
    const server = new ChannelServer(
      { onMessage: toServer.event, send: (buffer) => toClient.fire(buffer) },
      "host",
      1000,
      false,
      advertised,
    );
    expect(await client.getCapabilities()).toEqual(advertised ?? {});
    client.dispose();
    server.dispose();
    toClient.dispose();
    toServer.dispose();
  });
}
