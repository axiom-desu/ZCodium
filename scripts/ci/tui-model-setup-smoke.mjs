import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tsImport } from "tsx/esm/api";
import { setTimeout as delay } from "node:timers/promises";

async function waitForText(ui, act, pattern) {
  // Markdown 解析来自独立 worker；renderer idle 不代表 worker 已返回。
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => {
      await delay(20);
      await ui.flush();
    });
    await ui.renderOnce();
    if (pattern.test(ui.captureCharFrame())) return;
  }
  assert.match(ui.captureCharFrame(), pattern);
}

// Tree-sitter 使用测试专用缓存目录，避免触碰真实用户配置。
const cacheDirectory = await mkdtemp(join(tmpdir(), "zcodium-tui-model-setup-"));
process.env.XDG_DATA_HOME = cacheDirectory;

const {
  TuiApp,
  EmptyTranscriptLogo,
  ZCODIUM_LOGO_LINES,
  createCommandCenter,
  createTuiSubmitPrompt,
  listSlashCommandSuggestions,
  act,
  createElement,
  testRender,
  getTreeSitterClient,
} = await tsImport("./fixtures/tui-model-setup.ts", import.meta.url);

try {
  for (const locale of ["en-US", "zh-CN"]) {
    const treeSitter = getTreeSitterClient();
    await treeSitter.initialize();
    let ready = false;
    const prompts = [];
    let releaseResponse;
    const app = {
      submitPrompt: async (input) => {
        prompts.push(input);
        await new Promise((resolve) => {
          releaseResponse = resolve;
        });
        return { response: "Fixture model replied." };
      },
    };
    const commandResults = [];
    const busyHandler = createTuiSubmitPrompt(
      new Proxy(
        {},
        {
          get(_, key) {
            if (key === "shutdownCleanupTimeoutMs") return undefined;
            throw new Error(`Busy command reached app dependency: ${String(key)}`);
          },
        },
      ),
      {},
      "fixture",
      undefined,
      locale,
    );
    const commandCenter = createCommandCenter({
      getApp: async () => app,
      hasSelectableModels: () => ready,
      getLocale: () => locale,
    });
    const ui = await testRender(
      createElement(TuiApp, {
        copySelection: async () => ({ copied: false }),
        hasCopyableSelection: () => false,
        onExit: () => {},
        options: {
          locale,
          modelSetupRequired: true,
          submitPrompt: async (...args) => {
            const result = await commandCenter(...args);
            commandResults.push(result);
            return result;
          },
          sendInput: async (...args) => {
            const result = await busyHandler.sendInput(...args);
            assert.equal(result.kind, "command_result");
            commandResults.push(result.result);
            return result;
          },
          slashCommands: listSlashCommandSuggestions(),
          noColor: true,
          stdin: process.stdin,
          stdout: process.stdout,
          stderr: process.stderr,
          version: "fixture",
          workspaceDirectory: "/fixture/project",
        },
      }),
      { width: 140, height: 32 },
    );
    try {
      await act(async () => {
        await ui.flush();
      });
      await ui.renderOnce();
      assert.match(ui.captureCharFrame(), /provider_config\.json/);
      // 宽终端展开真实侧栏，避免只验 Logo 而漏掉常驻产品标题。
      assert.match(ui.captureCharFrame(), /ZCodium\s+fixture/);
      assert.doesNotMatch(ui.captureCharFrame(), /\bZCode\b/);
      assert.doesNotMatch(ui.captureCharFrame(), /\/login|Coding Plan/);
      await act(async () => {
        await ui.mockInput.typeText("/LOGIN fixture-private-key");
      });
      await act(async () => {
        ui.mockInput.pressEnter();
      });
      await act(async () => {
        await ui.flush();
      });
      await ui.renderOnce();
      assert.match(
        commandResults.at(-1)?.response ?? "",
        locale === "zh-CN" ? /账号登录已移除/ : /login has been removed/,
      );
      assert.equal(prompts.length, 0);
      assert.ok(!ui.captureCharFrame().includes("fixture-private-key"));
      await waitForText(ui, act, locale === "zh-CN" ? /账号登录已移除/ : /login has been removed/);
      // 模拟外部个人配置生效；下一次提交复用既有模型可用性检查并清除提示。
      ready = true;
      await act(async () => {
        await ui.mockInput.typeText("fixture question");
      });
      await act(async () => {
        ui.mockInput.pressEnter();
      });
      await act(async () => {
        await ui.flush();
      });
      await ui.renderOnce();
      assert.equal(prompts.length, 1);
      // 模型回复未完成时，通过真实 busy sendInput 入口再次拒绝退休命令。
      await act(async () => {
        await ui.mockInput.typeText("/LOGOUT fixture-private-key");
      });
      await act(async () => {
        ui.mockInput.pressEnter();
      });
      await act(async () => {
        await ui.flush();
      });
      await ui.renderOnce();
      assert.match(
        commandResults.at(-1)?.response ?? "",
        locale === "zh-CN" ? /已移除/ : /removed/,
      );
      assert.equal(prompts.length, 1);
      assert.ok(!ui.captureCharFrame().includes("fixture-private-key"));
      await act(async () => {
        releaseResponse();
      });
      assert.equal(commandResults.at(-1)?.response, "Fixture model replied.");
      await waitForText(ui, act, /Fixture model replied/);
      assert.doesNotMatch(
        ui.captureCharFrame(),
        locale === "zh-CN" ? /需要配置模型/ : /model setup required/,
      );
    } finally {
      releaseResponse?.();
      await busyHandler.close();
      await act(async () => {
        ui.renderer.destroy();
      });
      await treeSitter.destroy();
    }
  }
  // 实际终端 renderer 验证新版 Mark 与窄屏降级，不只检查纯函数/源码字符串。
  for (const width of [80, 20]) {
    const logo = await testRender(createElement(EmptyTranscriptLogo, { width: width - 2 }), {
      width,
      height: 12,
    });
    try {
      await act(async () => {
        await logo.flush();
      });
      await logo.renderOnce();
      const frame = logo.captureCharFrame();
      if (width === 80) assert.ok(frame.includes(ZCODIUM_LOGO_LINES[0]), frame);
      else {
        assert.match(frame, /ZCodium/);
        assert.ok(!frame.includes("████"), frame);
      }
    } finally {
      await act(async () => {
        logo.renderer.destroy();
      });
    }
  }
  console.log(
    "TUI model setup: Chinese/English guidance, retired login rejection and keyboard submission recovery passed.",
  );
} finally {
  await rm(cacheDirectory, { recursive: true, force: true });
}
