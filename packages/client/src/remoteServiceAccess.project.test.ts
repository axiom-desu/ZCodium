import { expect, it, vi } from "vitest";
import type { IChannelClient } from "@zcode/rpc";
import { IProjectService } from "@zcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";

it("only creates the Project channel proxy when the Host declared virtualProjects", () => {
  const getChannel = vi.fn((_name: string) => ({
    call: vi.fn(),
    listen: vi.fn(),
  }));
  const legacy = new RemoteServiceAccess({ getChannel } as unknown as IChannelClient);
  expect(legacy.projectService).toBeUndefined();
  expect(getChannel).not.toHaveBeenCalledWith(IProjectService.channelName);

  const capable = new RemoteServiceAccess({ getChannel } as unknown as IChannelClient, {
    virtualProjects: true,
  });
  expect(capable.projectService).toBeDefined();
  expect(getChannel).toHaveBeenCalledWith(IProjectService.channelName);
});
