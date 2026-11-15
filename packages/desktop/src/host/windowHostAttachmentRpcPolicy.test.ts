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
  IBotsService,
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
    // 数据同步面默认拒绝：设备同步状态 / Provisioning lane 只在本机 Host，
    // user-config-sync 不进手机与 Web allowlist。
    ServiceChannels.UserConfigSync,
    ServiceChannels.DeviceSyncState,
    ServiceChannels.ProviderProvisioningStatus,
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
    // Setting/ZCodeAgent/Bots 已方法级收窄：用各自允许的既有方法验证频道仍发布，不用未来 probe 名字。
    const allowedProbeMethod = (channel: string) =>
      channel === ServiceChannels.Setting
        ? "get"
        : channel === ServiceChannels.ZCodeAgent
          ? "listSessions"
          : channel === ServiceChannels.Bots
            ? "getStatus"
            : "probe";
    for (const channel of channels) {
      const method = allowedProbeMethod(channel);
      const probe = vi.fn(async () => channel);
      services.register(createServiceDescriptor<Record<string, typeof probe>>(channel), {
        [method]: probe,
      });
    }
    for (const mode of ["web-remote-replayable", "desktop-continuous"] as const) {
      const { client } = attach(services, mode);
      for (const channel of channels) {
        await expect(client.getChannel(channel).call(allowedProbeMethod(channel))).resolves.toBe(
          channel,
        );
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
      // 数据同步五方法同样只属于桌面：手机 attachment 必须 fail closed。
      "listSyncItems",
      "getSyncContentHashes",
      "checkSyncWriteAccess",
      "exportSyncItems",
      "importSyncItems",
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

  it("keeps topic-resource bytes and bot ingress callbacks off remote attachments", async () => {
    const calls: string[] = [];
    const method = (name: string) =>
      vi.fn(async () => {
        calls.push(name);
        return name;
      });
    const bots = {
      getStatus: method("getStatus"),
      saveBot: method("saveBot"),
      readTopicResource: method("readTopicResource"),
      validateTopicResource: method("validateTopicResource"),
      handleInboundMessage: method("handleInboundMessage"),
      handleProviderCallback: method("handleProviderCallback"),
      handleProviderCallbackResponse: method("handleProviderCallbackResponse"),
      watchAutomationRun: method("watchAutomationRun"),
      futureBotsMethod: method("futureBotsMethod"),
    };
    const services = new ServiceCollection().register(IBotsService, bots as never);
    // 手机与浏览器 Web 都只能看到 Bot 管理与读取面；字节下载与入站回调必须留在 Host 内部。
    for (const surface of ["mobile", "web-client"] as const) {
      const { client } = attach(services, "web-remote-replayable", undefined, surface);
      const channel = client.getChannel(ServiceChannels.Bots);
      await expect(channel.call("getStatus")).resolves.toBe("getStatus");
      await expect(channel.call("saveBot", [{}])).resolves.toBe("saveBot");
      for (const denied of [
        "readTopicResource",
        "validateTopicResource",
        "handleInboundMessage",
        "handleProviderCallback",
        "handleProviderCallbackResponse",
        "watchAutomationRun",
        "futureBotsMethod",
      ]) {
        await expect(channel.call(denied, [{}])).rejects.toMatchObject({
          kind: "feature_disabled",
        });
      }
    }
    expect(calls).toEqual(["getStatus", "saveBot", "getStatus", "saveBot"]);
    // 桌面本地 attachment 仍是完整服务面（CLI 反向 RPC 走同一 in-process 服务）。
    const desktop = attach(services, "desktop-continuous").client;
    await expect(
      desktop.getChannel(ServiceChannels.Bots).call("readTopicResource", [{}]),
    ).resolves.toBe("readTopicResource");
  });

  it("scopes Setting user instructions and Agent trust grants for remote attachments", async () => {
    const setting = {
      get: vi.fn(async () => ({ theme: "dark" })),
      update: vi.fn(async () => undefined),
      updateDataBaseDir: vi.fn(async () => undefined),
      ensureDefaultProject: vi.fn(async () => ({ path: "/tmp/p", created: false })),
      getUserInstructions: vi.fn(async () => ({ content: "secret", filePath: "/tmp/AGENTS.md" })),
      saveUserInstructions: vi.fn(async () => ({ filePath: "/tmp/AGENTS.md" })),
      futureSettingMethod: vi.fn(async () => "future"),
    };
    const agent = {
      setWorkspaceMcpTrust: vi.fn(async () => ({ accepted: true })),
      listSessions: vi.fn(async () => [{ id: "s1" }]),
    };
    const services = new ServiceCollection()
      .register(createServiceDescriptor<typeof setting>(ServiceChannels.Setting), setting)
      .register(createServiceDescriptor<typeof agent>(ServiceChannels.ZCodeAgent), agent);
    for (const surface of ["mobile", "web-client"] as const) {
      const { client } = attach(services, "web-remote-replayable", undefined, surface);
      const settingChannel = client.getChannel(ServiceChannels.Setting);
      await expect(settingChannel.call("get")).resolves.toEqual({ theme: "dark" });
      await expect(settingChannel.call("update", [{ theme: "light" }])).resolves.toBeUndefined();
      for (const method of ["getUserInstructions", "saveUserInstructions", "futureSettingMethod"]) {
        await expect(settingChannel.call(method, ["evil"])).rejects.toMatchObject({
          kind: "feature_disabled",
        });
      }
      const agentChannel = client.getChannel(ServiceChannels.ZCodeAgent);
      await expect(agentChannel.call("listSessions", [{}])).resolves.toEqual([{ id: "s1" }]);
      // Agent 通道不能绕过 McpSync 的方法收窄直接授予工作区 MCP 信任。
      await expect(agentChannel.call("setWorkspaceMcpTrust", [{}])).rejects.toMatchObject({
        kind: "feature_disabled",
      });
    }
    expect(setting.getUserInstructions).not.toHaveBeenCalled();
    expect(setting.saveUserInstructions).not.toHaveBeenCalled();
    expect(setting.futureSettingMethod).not.toHaveBeenCalled();
    expect(agent.setWorkspaceMcpTrust).not.toHaveBeenCalled();

    const desktop = attach(services, "desktop-continuous").client;
    await expect(
      desktop.getChannel(ServiceChannels.Setting).call("getUserInstructions"),
    ).resolves.toEqual({ content: "secret", filePath: "/tmp/AGENTS.md" });
    await expect(
      desktop.getChannel(ServiceChannels.ZCodeAgent).call("setWorkspaceMcpTrust", [{}]),
    ).resolves.toEqual({ accepted: true });
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
