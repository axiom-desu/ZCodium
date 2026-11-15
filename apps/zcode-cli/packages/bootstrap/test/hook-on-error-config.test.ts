// ============================================================
// F15 配置面：`onError` 从用户配置与插件 hooks 一路到达 Hook 注册
// ============================================================
// 不变式：
//   1. 用户配置里逐 hook 的 `onError` 不被配置层丢弃（CLI 配置 schema 对 hook 条目 passthrough）；
//   2. 插件 hooks.json 走 contracts 的 HookMatcherConfigSchema，`onError` 是声明字段；
//   3. 缺省时注册表不带 onError（= allow），与引入本字段前的行为一致。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HookConfigSchema,
  HookEventName,
  HookMatcherConfigSchema,
  HookOnErrorSchema,
} from "@zcode/contracts";
import { ZCodeConfigFileSchema } from "@zcode/adapters/config";
import { createConfiguredHookRunner } from "../../core/src/hooks/configured-runner.js";
import type { ConfiguredHookRunnerOptions } from "../../core/src/hooks/types.js";

const MATCHER = {
  matcher: "Bash",
  hooks: [{ command: "guard.sh", onError: "deny", type: "command" }],
};

describe("hook onError 配置面", () => {
  it("用户配置：hooks 条目保留 onError", () => {
    const parsed = ZCodeConfigFileSchema.parse({
      hooks: {
        enabled: true,
        events: { PreToolUse: [MATCHER] },
      },
    });
    const hook = parsed.hooks?.events?.PreToolUse?.[0]?.hooks?.[0];
    assert.equal((hook as { onError?: string } | undefined)?.onError, "deny");
  });

  it("插件 hooks：schema 把 onError 当声明字段，非法值被拒", () => {
    const parsed = HookMatcherConfigSchema.parse(MATCHER);
    assert.equal(parsed.hooks[0]?.onError, "deny");
    assert.equal(HookConfigSchema.safeParse({ command: "x", type: "command" }).success, true);
    assert.equal(
      HookConfigSchema.safeParse({ command: "x", onError: "fail", type: "command" }).success,
      false,
    );
    assert.equal(HookOnErrorSchema.safeParse("allow").success, true);
  });

  it("注册表：配了 onError 就带，缺席就不带", () => {
    const options = (matcher: typeof MATCHER): ConfiguredHookRunnerOptions =>
      ({
        config: {
          enabled: true,
          events: { [HookEventName.PreToolUse]: [matcher] },
          maxOutputBytes: 1024,
          timeoutMs: 1000,
        },
      }) as unknown as ConfiguredHookRunnerOptions;

    const withDeny = createConfiguredHookRunner(options(MATCHER)) as unknown as {
      hooks: Array<{ onError?: string }>;
    };
    assert.equal(withDeny.hooks[0]?.onError, "deny");

    const withoutOnError = createConfiguredHookRunner(
      options({ matcher: "Bash", hooks: [{ command: "guard.sh", type: "command" }] }),
    ) as unknown as { hooks: Array<{ onError?: string }> };
    assert.equal(withoutOnError.hooks[0]?.onError, undefined);
  });
});
