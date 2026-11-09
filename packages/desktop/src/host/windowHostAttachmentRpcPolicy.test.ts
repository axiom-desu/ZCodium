import { MessageChannel } from "node:worker_threads";
import {
  ChannelClient,
  ChannelServer,
  Emitter,
  MessagePortProtocol,
  ProxyChannel,
} from "@zcode/rpc";
import {
  createServiceDescriptor,
  IClientConfigService,
  IConversationShareService,
  IGenUiService,
  IMcpSyncService,
  IPluginSyncService,
  ISkillSyncService,
  ISourceServerManagementService,
  ITerminalService,
  IWindowControllerService,
  ServiceCollection,
  type ZCodeAgentV4ClientMode,
} from "@zcode/services";
import { ServiceChannels } from "@zcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scopeConversationShareServiceForAttachment } from "./conversationShareAttachmentService.js";
import { exposeWindowHostAttachmentServices } from "./windowHostAttachmentRpcPolicy.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

// 真实 MessagePort + RPC 编解码；仅内存服务，不初始化 Host/数据库/真实 PTY。
function attach(
  services: ServiceCollection,
  clientMode: ZCodeAgentV4ClientMode = "web-remote-replayable",
  overrides?: ReadonlyMap<string, unknown>,
  surface?: "mobile" | "web-client",
) {
  const { port1, port2 } = new MessageChannel();
  const serverProtocol = new MessagePortProtocol(port1);
  const clientProtocol = new MessagePortProtocol(port2);
  const client = new ChannelClient(clientProtocol);
  const server = new ChannelServer(serverProtocol, "test-host", 20, true);
  exposeWindowHostAttachmentServices({ server, services, clientMode, overrides, surface });
  server.ready();
  const dispose = () => {
    client.dispose();
    server.dispose();
    serverProtocol.disconnect();
    clientProtocol.disconnect();
    port1.close();
    port2.close();
  };
  cleanup.push(dispose);
  return { client, dispose };
}

function registerProbe(services: ServiceCollection, channel: string) {
  const probe = vi.fn(async () => channel);
  services.register(createServiceDescriptor<{ probe: typeof probe }>(channel), { probe });
  return probe;
}

describe("Host attachment authorization over real RPC", () => {
  it("defaults new channels to deny even with overrides; desktop still exposes them", async () => {
    const services = new ServiceCollection();
    const channel = "future-privileged-channel";
    const original = registerProbe(services, channel);
    const overridden = vi.fn(async () => "override");
    const overrides = new Map([[channel, { probe: overridden }]]);
    const mobile = attach(services, "web-remote-replayable", overrides);
    await expect(mobile.client.getChannel(channel).call("probe")).rejects.toMatchObject({
      name: "Unknown channel",
    });
    expect(original).not.toHaveBeenCalled();
    expect(overridden).not.toHaveBeenCalled();
    const desktop = attach(services, "desktop-continuous", overrides);
    await expect(desktop.client.getChannel(channel).call("probe")).resolves.toBe("override");
    expect(overridden).toHaveBeenCalledOnce();
    await expect(
      attach(services, "desktop-continuous").client.getChannel(channel).call("probe"),
    ).resolves.toBe(channel);
  });

  it.each([
    ServiceChannels.SkillSync,
    ServiceChannels.PluginSync,
    ServiceChannels.SourceServerManagement,
    ServiceChannels.ProviderProvisioningTarget,
    ServiceChannels.ClientConfig,
    ServiceChannels.PluginUiBridge,
    ServiceChannels.PluginUiSampling,
    ServiceChannels.PluginUiAppTools,
    ServiceChannels.AstrBotBridge,
  ])("denies %s on mobile without restricting desktop", async (channel) => {
    const services = new ServiceCollection();
    const probe = registerProbe(services, channel);
    const mobile = attach(services);
    await expect(mobile.client.getChannel(channel).call("probe")).rejects.toMatchObject({
      name: "Unknown channel",
    });
    expect(probe).not.toHaveBeenCalled();
    const desktop = attach(services, "desktop-continuous");
    await expect(desktop.client.getChannel(channel).call("probe")).resolves.toBe(channel);
    expect(probe).toHaveBeenCalledOnce();
  });

  it("retains the reviewed mobile service surface in both delivery modes", async () => {
    const channels = [
      ServiceChannels.File,
      ServiceChannels.MediaPreview,
      ServiceChannels.System,
      ServiceChannels.Terminal,
      ServiceChannels.Git,
      ServiceChannels.GitCheckpoint,
      ServiceChannels.Setting,
      ServiceChannels.OnboardingRecord,
      ServiceChannels.Credential,
      ServiceChannels.CuaPermission,
      ServiceChannels.Broadcast,
      ServiceChannels.ZCodeTask,
      ServiceChannels.WindowController,
      ServiceChannels.ZCodeAgent,
      ServiceChannels.ZCodeSession,
      ServiceChannels.Project,
      ServiceChannels.ConversationShare,
      ServiceChannels.FileWatcher,
      ServiceChannels.ProviderSettings,
      ServiceChannels.ModelSelection,
      ServiceChannels.UsageStats,
      ServiceChannels.CodingPlanSubscription,
      ServiceChannels.ClientScenes,
      ServiceChannels.Skills,
      ServiceChannels.Plugins,
      ServiceChannels.PluginManagement,
      ServiceChannels.Subagents,
      ServiceChannels.Commands,
      ServiceChannels.Hooks,
      ServiceChannels.Memory,
      ServiceChannels.SettingsSync,
      ServiceChannels.Bots,
      ServiceChannels.PromptAttachmentTransfer,
    ];
    const services = new ServiceCollection();
    for (const channel of channels) registerProbe(services, channel);
    for (const mode of ["web-remote-replayable", "desktop-continuous"] as const) {
      const { client } = attach(services, mode);
      for (const channel of channels) {
        await expect(client.getChannel(channel).call("probe")).resolves.toBe(channel);
      }
    }
  });

  it("preserves approved settings methods, parameters and events", async () => {
    const events = new Emitter<string>();
    cleanup.push(() => events.dispose());
    const listen = vi.fn(events.event);
    const setting = {
      marker: "original-owner",
      async update(...args: unknown[]) {
        return { marker: this.marker, args };
      },
      onDidChange: listen,
    };
    const services = new ServiceCollection().register(
      createServiceDescriptor<typeof setting>(ServiceChannels.Setting),
      setting,
    );
    const { client } = attach(services);
    const remote = ProxyChannel.toService<typeof setting>(
      client.getChannel(ServiceChannels.Setting),
    );
    await expect(remote.update({ theme: "dark" }, 2)).resolves.toEqual({
      marker: "original-owner",
      args: [{ theme: "dark" }, 2],
    });
    const received = vi.fn();
    const subscription = remote.onDidChange(received);
    cleanup.push(() => subscription.dispose());
    await vi.waitFor(() => expect(listen).toHaveBeenCalledOnce());
    events.fire("dark");
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith("dark"));
  });

  it("allows only existing MCP settings methods, preserving overrides and this", async () => {
    const allowed = [
      "loadMcpFromUserDirectory",
      "saveMcpToUserDirectory",
      "listWorkspaceMcpServerStatuses",
    ] as const satisfies ReadonlyArray<keyof IMcpSyncService>;
    const denied = [
      "listLocalUserMcpCandidates",
      "listRemoteUserMcpStatuses",
      "exportMcpServers",
      "checkRemoteUserMcpWriteAccess",
      "importMcpServers",
      "futureSyncMethod",
      "setWorkspaceMcpTrust",
      "constructor",
    ];
    const baseCalls = vi.fn();
    const overrideCalls = vi.fn();
    function makeService(marker: string, calls: typeof baseCalls) {
      const service: Record<string, unknown> = { marker };
      for (const method of [...allowed, ...denied]) {
        service[method] = async function (this: { marker: string }, ...args: unknown[]) {
          calls(method, ...args);
          return { marker: this.marker, args };
        };
      }
      return service as unknown as IMcpSyncService;
    }
    const base = makeService("base", baseCalls);
    const override = makeService("attachment", overrideCalls);
    const services = new ServiceCollection().register(IMcpSyncService, base);
    const overrides = new Map([[IMcpSyncService.channelName, override]]);
    for (const useOverride of [false, true]) {
      const { client } = attach(
        services,
        "web-remote-replayable",
        useOverride ? overrides : undefined,
      );
      const channel = client.getChannel(IMcpSyncService.channelName);
      for (const method of allowed) {
        await expect(
          channel.call(method, [{ workspaceIdentity: "test-identity" }, "second"]),
        ).resolves.toEqual({
          marker: useOverride ? "attachment" : "base",
          args: [{ workspaceIdentity: "test-identity" }, "second"],
        });
      }
      for (const method of denied) {
        await expect(channel.call(method, [{}])).rejects.toMatchObject({
          kind: "feature_disabled",
        });
      }
    }
    expect(baseCalls.mock.calls.map(([method]) => method)).toEqual(allowed);
    expect(overrideCalls.mock.calls.map(([method]) => method)).toEqual(allowed);
    const desktop = attach(services, "desktop-continuous", overrides);
    await expect(
      desktop.client.getChannel(IMcpSyncService.channelName).call("importMcpServers", [{}]),
    ).resolves.toEqual({ marker: "attachment", args: [{}] });
  });

  it("exposes only Gen UI listState, without publishing sandbox or write methods", async () => {
    const listState = vi.fn(async () => [{ id: "state" }]);
    const prepare = vi.fn(async () => "sandbox");
    const services = new ServiceCollection().register(IGenUiService, {
      listState,
      prepare,
    } as never);
    const mobile = attach(services).client.getChannel(IGenUiService.channelName);
    await expect(mobile.call("listState", [{ sessionId: "test" }])).resolves.toEqual([
      { id: "state" },
    ]);
    for (const method of ["prepare", "futureWrite", "constructor", "toString"]) {
      await expect(mobile.call(method, [{}])).rejects.toThrow("Method not found");
    }
    expect(prepare).not.toHaveBeenCalled();
    await expect(
      attach(services, "desktop-continuous")
        .client.getChannel(IGenUiService.channelName)
        .call("prepare", [{}]),
    ).resolves.toBe("sandbox");
  });

  it("retains the existing conversation sharing attachment wrapper", async () => {
    const publish = vi.fn(async () => "published");
    const base = {
      getCapabilities: async () => ({ canPublish: false }),
      publish,
    } as unknown as IConversationShareService;
    const services = new ServiceCollection().register(IConversationShareService, base);
    const scoped = scopeConversationShareServiceForAttachment(base, "web-remote-replayable");
    const { client } = attach(
      services,
      "web-remote-replayable",
      new Map([[IConversationShareService.channelName, scoped]]),
    );
    const channel = client.getChannel(IConversationShareService.channelName);
    await expect(channel.call("getCapabilities")).resolves.toEqual({ canPublish: false });
    await expect(channel.call("publish", [{}])).rejects.toMatchObject({ kind: "feature_disabled" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not turn RPC attachment replacement into Terminal ownership or cleanup", async () => {
    const dispose = vi.fn(async () => {});
    const write = vi.fn(async () => {});
    const create = vi.fn(async () => ({ id: "existing-pty" }));
    const services = new ServiceCollection().register(ITerminalService, {
      create,
      write,
      dispose,
    } as never);
    const first = attach(services);
    const second = attach(services);
    await expect(
      first.client
        .getChannel(ITerminalService.channelName)
        .call("create", [{ cols: 80, rows: 24 }]),
    ).resolves.toEqual({ id: "existing-pty" });
    first.dispose();
    expect(dispose).not.toHaveBeenCalled();
    await second.client
      .getChannel(ITerminalService.channelName)
      .call("write", [{ id: "existing-pty", data: "x" }]);
    expect(write).toHaveBeenCalledWith({ id: "existing-pty", data: "x" });
    await second.client
      .getChannel(ITerminalService.channelName)
      .call("dispose", [{ id: "existing-pty" }]);
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("browser web-client surface", () => {
  it("allows the channels the Web client actually uses, but keeps device/window/credential write surfaces closed", async () => {
    const calls: string[] = [];
    // ServiceCollection 暴露的是「服务对象」，方法经 ProxyChannel 按名映射，不是 IServerChannel。
    const probeService = (name: string) => ({
      invoke: async () => {
        calls.push(name);
        return { ok: true };
      },
    });
    const services = new ServiceCollection()
      .register(IClientConfigService, probeService("client-config") as never)
      .register(ISkillSyncService, probeService("skill-sync") as never)
      .register(IPluginSyncService, probeService("plugin-sync") as never)
      .register(IWindowControllerService, probeService("window-controller") as never)
      .register(ISourceServerManagementService, probeService("source-server-management") as never);

    const attached = attach(services, "web-remote-replayable", undefined, "web-client");
    for (const channel of [
      ServiceChannels.ClientConfig,
      ServiceChannels.SkillSync,
      ServiceChannels.PluginSync,
    ]) {
      await expect(attached.client.getChannel(channel as never).call("invoke")).resolves.toEqual({
        ok: true,
      });
    }
    for (const channel of [
      ServiceChannels.WindowController,
      ServiceChannels.SourceServerManagement,
    ]) {
      await expect(
        attached.client.getChannel(channel as never).call("invoke"),
      ).rejects.toBeInstanceOf(Error);
    }
    // 桌面专用频道确实没有被调到，而不是「调到了但返回错误」。
    expect(calls).toEqual(["client-config", "skill-sync", "plugin-sync"]);
    attached.dispose();
  });

  it("keeps the mobile subset unchanged when the surface is not declared", async () => {
    const calls: string[] = [];
    const services = new ServiceCollection().register(ISkillSyncService, {
      invoke: async () => {
        calls.push("skill-sync");
        return { ok: true };
      },
    } as never);
    const attached = attach(services);
    await expect(
      attached.client.getChannel(ISkillSyncService.channelName as never).call("invoke"),
    ).rejects.toBeInstanceOf(Error);
    expect(calls).toEqual([]);
    attached.dispose();
  });
});
