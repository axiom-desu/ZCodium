import { describe, expect, it } from "vitest";
import {
  buildWorkspaceHookBundleSnapshot,
  createWorkspaceHookDeclarationDigest,
  type CanonicalWorkspaceHookEntryData,
} from "../src/workspace-hook-digest.js";
import { workspaceHooksConfigSchema } from "../src/workspace-hook-config.js";

// 工作区 hook 的 onError 必须进入声明摘要：引入该字段会让既有信任整体 stale 一次（一次性
// 重新审核）；此后新增/修改 onError 也会再次触发 stale，防止在已被信任的声明上静默改失败语义。

const workspacePath = "/tmp/workspace-hook-on-error";
const source = (onError?: "allow" | "deny") => ({
  canonicalPath: `${workspacePath}/.zcodium/config.json`,
  baseDir: workspacePath,
  discoveryOrder: 0,
  configFileKind: "zcodium.json" as const,
  explicitProjectConfig: true,
  editable: true,
  hooks: {
    events: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command" as const,
              command: "echo guarded",
              ...(onError ? { onError } : {}),
            },
          ],
        },
      ],
    },
  },
});

const runtimeRoot = { enabled: true, timeoutMs: 60_000, maxOutputBytes: 32_768 } as const;

function entry(onError?: "allow" | "deny"): CanonicalWorkspaceHookEntryData {
  const snapshot = buildWorkspaceHookBundleSnapshot({
    workspaceIdentity: workspacePath,
    workspacePath,
    sources: [source(onError)],
    runtimeRoot,
    discoveredAt: "2026-11-01T00:00:00.000Z",
  });
  expect(snapshot).toBeDefined();
  return snapshot!.hooks[0]!;
}

describe("工作区 hook onError 与信任摘要", () => {
  it("config schema 接受 onError，且参与 bundle 摘要", () => {
    const parsed = workspaceHooksConfigSchema.parse(source("deny").hooks);
    expect(parsed.events?.PreToolUse?.[0]?.hooks[0]?.onError).toBe("deny");

    const without = entry();
    const allow = entry("allow");
    const deny = entry("deny");
    // 无 onError / allow / deny 得到不同摘要 → stale_digest → 必须重新信任一次。
    expect(without.hookDeclarationDigest).not.toEqual(allow.hookDeclarationDigest);
    expect(allow.hookDeclarationDigest).not.toEqual(deny.hookDeclarationDigest);
    expect(without.onError).toBeUndefined();
    expect(deny.onError).toBe("deny");
  });

  it("声明摘要函数对 onError 变化敏感，对同等输入稳定", () => {
    const base = {
      sourceRelativePath: ".zcodium/config.json",
      sourceDiscoveryOrder: 0,
      event: "PreToolUse" as const,
      matcher: "Bash",
      matcherIndex: 0,
      hookIndex: 0,
      defaultTimeoutMs: 60_000,
      resolvedMaxOutputBytes: 32_768,
    };
    const hook = (onError?: "allow" | "deny") => ({
      type: "process" as const,
      command: "run",
      args: ["--x"],
      ...(onError ? { onError } : {}),
    });
    const first = createWorkspaceHookDeclarationDigest({ ...base, hook: hook("allow") });
    expect(createWorkspaceHookDeclarationDigest({ ...base, hook: hook("allow") })).toBe(first);
    expect(createWorkspaceHookDeclarationDigest({ ...base, hook: hook("deny") })).not.toBe(first);
    expect(createWorkspaceHookDeclarationDigest({ ...base, hook: hook() })).not.toBe(first);
  });
});
