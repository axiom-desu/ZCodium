import { describe, expect, it } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import { buildServerRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  resolveWorkspaceRemoteSessionId,
  resolveWorkspaceServices,
  type WorkspaceServiceResolverState,
} from "@/lib/workspaceServiceResolver.js";

const sourceA = "11111111-1111-4111-8111-111111111111";

function accessor(token: string): IServiceAccessor {
  return { token } as unknown as IServiceAccessor;
}

function state(bindings: Record<string, string>): WorkspaceServiceResolverState {
  const sessionsById: WorkspaceServiceResolverState["sessionsById"] = {};
  const sessionIdByWorkspaceIdentity: WorkspaceServiceResolverState["sessionIdByWorkspaceIdentity"] =
    {};
  for (const [identity, sessionId] of Object.entries(bindings)) {
    sessionsById[sessionId] = { services: accessor(sessionId) };
    sessionIdByWorkspaceIdentity[identity] = sessionId;
  }
  return { sessionsById, sessionIdByWorkspaceIdentity, sessionIdByWorkspacePath: {} };
}

describe("workspace service 解析的 logical scope", () => {
  it("拒绝把同 Source 另一个 identity 的 session 借给当前目录", () => {
    const openDir = buildServerRemoteWorkspaceIdentity({
      serverId: sourceA,
      workspacePath: "/open-dir",
    });
    const newDir = buildServerRemoteWorkspaceIdentity({
      serverId: sourceA,
      workspacePath: "/new-dir",
    });
    const resolverState = state({ [openDir]: "logical-open-dir" });

    expect(
      resolveWorkspaceRemoteSessionId(
        {
          workspacePath: "/new-dir",
          workspaceIdentity: newDir,
          // 旧 catalog 的跨目录借用：session 存在，但绑定的是另一个 identity。
          remoteSessionId: "logical-open-dir",
        },
        resolverState,
      ),
    ).toBeUndefined();
    expect(
      resolveWorkspaceServices(
        {
          workspacePath: "/new-dir",
          workspaceIdentity: newDir,
          remoteSessionId: "logical-open-dir",
        },
        accessor("base"),
        resolverState,
      ),
    ).toBeNull();
  });

  it("exact identity 绑定与自己的 remoteSessionId 才使用该 logical accessor", () => {
    const openDir = buildServerRemoteWorkspaceIdentity({
      serverId: sourceA,
      workspacePath: "/open-dir",
    });
    const resolverState = state({ [openDir]: "logical-open-dir" });
    const resolved = resolveWorkspaceServices(
      {
        workspacePath: "/open-dir",
        workspaceIdentity: openDir,
        remoteSessionId: "logical-open-dir",
      },
      accessor("base"),
      resolverState,
    );
    expect(resolved?.remoteSessionId).toBe("logical-open-dir");
    expect(resolved?.services).toBe(resolverState.sessionsById["logical-open-dir"].services);
  });

  it("同 Source 同 path 的两个 legacy identity 各自解析自己的 session", () => {
    const legacyOne = "remote:ssh:host-a:22:user-a:/shared";
    const legacyTwo = "remote:ssh:host-a:22:user-b:/shared";
    const resolverState = state({
      [legacyOne]: "logical-1",
      [legacyTwo]: "logical-2",
    });
    expect(
      resolveWorkspaceRemoteSessionId(
        { workspacePath: "/shared", workspaceIdentity: legacyOne, remoteSessionId: "logical-1" },
        resolverState,
      ),
    ).toBe("logical-1");
    expect(
      resolveWorkspaceRemoteSessionId(
        { workspacePath: "/shared", workspaceIdentity: legacyTwo, remoteSessionId: "logical-2" },
        resolverState,
      ),
    ).toBe("logical-2");
    // 借来的 session 被拒后，只能回落该 identity 自己的绑定。
    expect(
      resolveWorkspaceRemoteSessionId(
        { workspacePath: "/shared", workspaceIdentity: legacyOne, remoteSessionId: "logical-2" },
        resolverState,
      ),
    ).toBe("logical-1");
  });

  it("没有 identity 的旧 remote tab 才允许按 path 恢复", () => {
    const resolverState: WorkspaceServiceResolverState = {
      sessionsById: { "legacy-session": { services: accessor("legacy") } },
      sessionIdByWorkspaceIdentity: {},
      sessionIdByWorkspacePath: { "/legacy": "legacy-session" },
    };
    expect(
      resolveWorkspaceRemoteSessionId(
        { workspacePath: "/legacy", remoteTarget: { kind: "ssh" } },
        resolverState,
      ),
    ).toBe("legacy-session");
    expect(
      resolveWorkspaceRemoteSessionId({ workspacePath: "/legacy" }, resolverState),
    ).toBeUndefined();
  });

  it("本地 target 继续使用 base services", () => {
    const base = accessor("base");
    const resolved = resolveWorkspaceServices({ workspacePath: "/local" }, base, state({}));
    expect(resolved?.services).toBe(base);
    expect(resolved?.isRemoteWorkspace).toBe(false);
  });
});
