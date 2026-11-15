import { expect, it, vi } from "vitest";
import type { IChannelClient } from "@zcode/rpc";
import { IExtensionsService } from "@zcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";

it("only creates the Extensions channel proxy for the local desktop base attachment", () => {
  const getChannel = vi.fn((_name: string) => ({
    call: vi.fn(),
    listen: vi.fn(),
  }));
  // 远程/手机/Web 默认不创建代理：频道名不会出现在 getChannel 调用里。
  const remote = new RemoteServiceAccess({ getChannel } as unknown as IChannelClient);
  expect(remote.extensionsService).toBeUndefined();
  expect(getChannel).not.toHaveBeenCalledWith(IExtensionsService.channelName);

  const local = new RemoteServiceAccess({ getChannel } as unknown as IChannelClient, {
    localExtensions: true,
  });
  expect(local.extensionsService).toBeDefined();
  expect(getChannel).toHaveBeenCalledWith(IExtensionsService.channelName);
});
