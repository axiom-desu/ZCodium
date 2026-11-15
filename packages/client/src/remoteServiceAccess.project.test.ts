import { expect, it, vi } from "vitest";
import type { IChannelClient } from "@zcode/rpc";
import { IManagedWorktreeService, IProjectService, IRemoteProjectService } from "@zcode/services";
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

it("creates worktree/remote-project proxies only for the local Host attachment", () => {
  const getChannel = vi.fn((_name: string) => ({
    call: vi.fn(),
    listen: vi.fn(),
  }));
  const remote = new RemoteServiceAccess({ getChannel } as unknown as IChannelClient, {
    virtualProjects: true,
  });
  expect(remote.managedWorktreeService).toBeUndefined();
  expect(remote.remoteProjectService).toBeUndefined();
  expect(getChannel).not.toHaveBeenCalledWith(IManagedWorktreeService.channelName);

  const local = new RemoteServiceAccess({ getChannel } as unknown as IChannelClient, {
    localHostServices: true,
  });
  expect(local.managedWorktreeService).toBeDefined();
  expect(local.remoteProjectService).toBeDefined();
  expect(getChannel).toHaveBeenCalledWith(IManagedWorktreeService.channelName);
  expect(getChannel).toHaveBeenCalledWith(IRemoteProjectService.channelName);
});
