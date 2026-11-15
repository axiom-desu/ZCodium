import { describe, expect, it, vi } from "vitest";
import type { ISourceServerManagementService } from "@zcode/services";
import {
  formatSourceServerRunningTasks,
  getRemoteServiceLifecycleDescription,
  getSourceServerDowngradeConfirmation,
  resolveSourceServerDowngradeActionAvailability,
  resolveSourceServerLifecycleActionAvailability,
  resolveSourceServerUpdateCancelAvailability,
  runSourceServerUpdate,
} from "../src/lib/sourceServerUpdateAction.js";

function formatMessage(descriptor: { id: string }, values?: Record<string, string>) {
  return values ? `${descriptor.id}:${JSON.stringify(values)}` : descriptor.id;
}

describe("source lifecycle availability", () => {
  it("gates stop/restart on the lifecycle contract version without probing", () => {
    expect(
      resolveSourceServerLifecycleActionAvailability({
        state: "online",
        deviceBusy: false,
        lastSeenVersion: "3.17.0",
      }),
    ).toEqual({ visible: true, enabled: true, requiresRemoteUpdate: false });
    expect(
      resolveSourceServerLifecycleActionAvailability({
        state: "online",
        deviceBusy: false,
        lastSeenVersion: "3.16.9",
      }),
    ).toEqual({ visible: true, enabled: false, requiresRemoteUpdate: true });
    expect(
      resolveSourceServerLifecycleActionAvailability({
        state: "offline",
        deviceBusy: false,
      }),
    ).toEqual({ visible: true, enabled: false, requiresRemoteUpdate: true });
    expect(
      resolveSourceServerLifecycleActionAvailability({
        state: "needs-upgrade",
        deviceBusy: false,
        lastSeenVersion: "3.17.0",
      }),
    ).toEqual({ visible: false });
    expect(
      resolveSourceServerLifecycleActionAvailability({
        state: "retrying",
        deviceBusy: true,
        lastSeenVersion: "3.17.0",
      }),
    ).toEqual({ visible: true, enabled: false, requiresRemoteUpdate: false });
  });

  it("shows cancel only for the local cancellable update stage", () => {
    expect(
      resolveSourceServerUpdateCancelAvailability({
        state: "updating",
        updateCancelable: true,
        deviceBusy: false,
      }),
    ).toEqual({ visible: true, enabled: true });
    expect(
      resolveSourceServerUpdateCancelAvailability({ state: "updating", deviceBusy: false }),
    ).toEqual({ visible: false, enabled: false });
  });

  it("shows explicit downgrade only when the remote is newer", () => {
    expect(
      resolveSourceServerDowngradeActionAvailability({
        state: "online",
        updateAvailability: "required",
        upgradeTarget: "controller",
        currentVersion: "3.19.0",
        deviceBusy: false,
      }),
    ).toEqual({ visible: true, enabled: true });
    expect(
      resolveSourceServerDowngradeActionAvailability({
        state: "online",
        updateAvailability: "available",
        upgradeTarget: "server",
        currentVersion: "3.19.0",
        deviceBusy: false,
      }),
    ).toEqual({ visible: false, enabled: false });
  });
});

describe("source lifecycle copy", () => {
  it("lists running tasks or marks the list unavailable", () => {
    expect(
      formatSourceServerRunningTasks([
        { sessionId: "s1", workspacePath: "/w/1" },
        { sessionId: "s2", workspacePath: "/w/2" },
      ]),
    ).toBe("s1 — /w/1 · s2 — /w/2");
    const unavailable = getRemoteServiceLifecycleDescription({
      action: "restart",
      runningTasks: { available: false },
      startupAutoReconnect: false,
      formatMessage: (id) => id,
    });
    expect(unavailable).toContain("source.lifecycle.runningTasksUnavailable");
    const empty = getRemoteServiceLifecycleDescription({
      action: "stop",
      runningTasks: { available: true, tasks: [] },
      startupAutoReconnect: true,
      formatMessage: (id) => id,
    });
    expect(empty).toContain("source.lifecycle.noRunningTasks");
    expect(empty).toContain("source.lifecycle.stopStartupReconnect");
  });

  it("builds downgrade confirmation from Host snapshot versions", () => {
    expect(
      getSourceServerDowngradeConfirmation(
        { currentVersion: "v3.19.0", availableVersion: "v3.18.2" },
        formatMessage,
      ),
    ).toEqual({
      title: 'source.downgradeConfirmTitle:{"version":"3.19.0","current":"3.18.2"}',
      description: 'source.downgradeConfirmDescription:{"version":"3.19.0","current":"3.18.2"}',
      confirmLabel: "source.downgradeConfirm",
      cancelLabel: "common.cancel",
    });
  });
});

describe("runSourceServerUpdate", () => {
  const management = (updateSource: ReturnType<typeof vi.fn>) =>
    ({ updateSource }) as unknown as ISourceServerManagementService;

  it("requires an explicit force confirmation after the running-task guard", async () => {
    const updateSource = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error("busy"), {
        code: "source-server-update-running-tasks",
      }),
    );
    const confirmForce = vi.fn(async () => false);
    const result = await runSourceServerUpdate({
      management: management(updateSource),
      profileId: "p1",
      allowDowngrade: true,
      confirmForce,
    });
    expect(result).toBeNull();
    expect(updateSource).toHaveBeenCalledTimes(1);
    expect(updateSource).toHaveBeenCalledWith({
      profileId: "p1",
      force: false,
      allowDowngrade: true,
    });
    expect(confirmForce).toHaveBeenCalledTimes(1);
  });

  it("sends force and allowDowngrade only after confirmation", async () => {
    const snapshot = { generation: 1 };
    const updateSource = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("busy"), {
          code: "source-server-update-running-tasks",
        }),
      )
      .mockResolvedValueOnce(snapshot);
    const result = await runSourceServerUpdate({
      management: management(updateSource),
      profileId: "p1",
      allowDowngrade: true,
      confirmForce: async () => true,
    });
    expect(result).toBe(snapshot);
    expect(updateSource).toHaveBeenLastCalledWith({
      profileId: "p1",
      force: true,
      allowDowngrade: true,
    });
  });

  it("does not turn other update errors into success", async () => {
    const error = Object.assign(new Error("downgrade"), {
      code: "source-server-downgrade-unconfirmed",
    });
    const updateSource = vi.fn().mockRejectedValue(error);
    await expect(
      runSourceServerUpdate({
        management: management(updateSource),
        profileId: "p1",
        confirmForce: async () => true,
      }),
    ).rejects.toBe(error);
  });
});
