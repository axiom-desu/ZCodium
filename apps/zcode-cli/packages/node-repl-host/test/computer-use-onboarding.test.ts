import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * CUA 的输出策略：参考按需取用，宿主不主动推。
 *
 * 上游把这套口径钉成一条断言，这里再补一条：按需取用的那份必须是**完整参考**
 * （含 `## Tool arguments` 等小节）——模型需要参数形状时才付这份预算，参考若被砍成
 * 链路说明，这个测试就是它的守卫。
 *
 * 移植自上游 3.15.1 的 test/computer-use-onboarding.test.ts：断言语义一致，runner 换成
 * node:test（本仓库 apps/zcode-cli 内已有这个入口，见 packages/debug），bridge 用手写 stub。
 */

const WRITTEN: string[] = [];

const pluginScript = fileURLToPath(
  new URL("../../zcode-cua-plugin/scripts/computer-use-client.mjs", import.meta.url),
);
const referencePath = join(dirname(pluginScript), "..", "docs", "computer-use.md");

async function makeGlobals() {
  const bridge = {
    call: async () => ({ content: [{ type: "text", text: "ok" }] }),
    assertAvailable: () => undefined,
    documentationRoot: dirname(referencePath),
  };
  const globals: Record<string, unknown> = {
    [Symbol.for("zcode.node-repl.computer-use-bridge")]: bridge,
    nodeRepl: {
      write: (text: string) => {
        WRITTEN.push(text);
      },
    },
  };
  const mod = (await import(pluginScript)) as {
    setupComputerUseRuntime(input: { globals: Record<string, unknown> }): Promise<unknown>;
  };
  await mod.setupComputerUseRuntime({ globals });
  return globals as unknown as {
    agent: {
      computerUse: { computer: Record<string, (args?: object) => Promise<unknown>> };
      documentation: { get(name: string): Promise<string> };
    };
  };
}

const referenceOf = (writes: readonly string[]) =>
  writes.find((text) => text.startsWith("# Computer Use"));

describe("computer-use output policy", () => {
  it("never pushes the reference, on the first call or any later one", async () => {
    WRITTEN.length = 0;
    const globals = await makeGlobals();
    await globals.agent.computerUse.computer.list_apps?.({});
    assert.equal(referenceOf(WRITTEN), undefined);
    await globals.agent.computerUse.computer.list_apps?.({});
    assert.equal(referenceOf(WRITTEN), undefined);
  });

  it("serves the reference through agent.documentation for the model to write", async () => {
    const globals = await makeGlobals();
    const doc = await globals.agent.documentation.get("computer-use");
    assert.match(doc, /^# Computer Use/u);
    assert.match(doc, /## Tool arguments/u);
  });
});

describe("computer-use reference", () => {
  it("stays a complete reference rather than a chain summary", async () => {
    const doc = await readFile(referencePath, "utf8");
    for (const section of ["## API", "## Tool arguments", "## Observations", "## Errors"]) {
      assert.ok(doc.includes(section), `reference is missing ${section}`);
    }
  });
});
