import assert from "node:assert/strict";
import { runBurstApprovalChecks } from "./fixtures/tui-quit-burst.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tsImport } from "tsx/esm/api";

const cache = await mkdtemp(join(tmpdir(), "zcodium-quit-render-"));
process.env.XDG_DATA_HOME = cache;
const {
  TuiApp,
  act,
  createElement,
  testRender,
  getTreeSitterClient,
  isTuiQuitInput,
  tuiSlashCommands,
} = await tsImport("./fixtures/tui-quit.ts", import.meta.url);
const treeSitter = getTreeSitterClient();
await treeSitter.initialize();
async function mount({
  submitPrompt,
  modelSetupRequired = false,
  onExit,
  locale = "en-US",
  readClipboardImage,
}) {
  const ui = await testRender(
    createElement(TuiApp, {
      copySelection: async () => ({ copied: false }),
      hasCopyableSelection: () => false,
      onExit,
      options: {
        locale,
        modelSetupRequired,
        submitPrompt,
        readClipboardImage,
        noColor: true,
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        version: "fixture",
        workspaceDirectory: "/fixture/project",
      },
    }),
    { width: 100, height: 30, kittyKeyboard: true },
  );
  await act(async () => {
    await ui.flush();
  });
  await ui.renderOnce();
  return ui;
}
async function submit(ui, value) {
  await act(async () => {
    if (value.includes("\n")) await ui.mockInput.pasteBracketedText(value);
    else await ui.mockInput.typeText(value);
  });
  await act(async () => {
    ui.mockInput.pressEnter();
    await ui.flush();
  });
  await ui.renderOnce();
}
async function destroy(ui) {
  await act(async () => {
    ui.renderer.destroy();
  });
}
try {
  for (const text of ["/quit", " /QuIt ", "\t/quit\t"]) assert.equal(isTuiQuitInput(text), true);
  for (const text of ["/quitfoo", "/quit args", "first\n/quit", "/quit\n", "/quit\r\n"])
    assert.equal(isTuiQuitInput(text), false);
  assert.equal(isTuiQuitInput("/quit", true), false);
  assert.equal(
    tuiSlashCommands([{ name: "quit", summary: "custom", usage: "/quit" }]).filter(
      (c) => c.name === "quit",
    ).length,
    1,
  );
  for (const locale of ["en-US", "zh-CN"])
    for (const modelSetupRequired of [false, true]) {
      let exits = 0,
        calls = 0;
      const ui = await mount({
        locale,
        modelSetupRequired,
        onExit: () => {
          exits++;
        },
        submitPrompt: async () => {
          calls++;
          return { response: "" };
        },
      });
      try {
        await act(async () => {
          await ui.mockInput.typeText("/qui");
          await ui.flush();
        });
        await ui.renderOnce();
        assert.match(ui.captureCharFrame(), locale === "zh-CN" ? /退出终端界面/ : /Exit the TUI/);
        await act(async () => {
          await ui.mockInput.typeText("t");
          ui.mockInput.pressEnter();
          await ui.flush();
        });
        assert.equal(exits, 1);
        assert.equal(calls, 0);
        await act(async () => {
          ui.mockInput.pressEnter();
          await ui.flush();
        });
        assert.equal(exits, 1, "idempotent quit");
      } finally {
        await destroy(ui);
      }
    }
  {
    let exits = 0,
      calls = 0,
      signal,
      release;
    const ui = await mount({
      onExit: () => {
        exits++;
      },
      submitPrompt: async (_input, options) => {
        calls++;
        signal = options.abortSignal;
        await new Promise((done) => {
          release = done;
        });
        return { response: "" };
      },
    });
    try {
      await submit(ui, "start");
      await submit(ui, "/quit");
      assert.equal(exits, 1);
      assert.equal(calls, 1);
      assert.equal(signal.aborted, true);
    } finally {
      await act(async () => {
        release?.();
        await ui.flush();
      });
      await destroy(ui);
    }
  }
  {
    let exits = 0,
      calls = 0;
    const ui = await mount({
      onExit: () => {
        exits++;
      },
      submitPrompt: async () => {
        calls++;
        return { response: "" };
      },
    });
    try {
      await submit(ui, "/qui");
      assert.equal(exits, 1, "Enter on the selected /quit completion exits locally");
      assert.equal(calls, 0);
    } finally {
      await destroy(ui);
    }
  }
  // 审批/问答已经占用键盘后再输入退出，不能只测“事先在草稿里放好 /quit”。
  for (const question of [false, true, "other-path", "other-quit"]) {
    let exits = 0,
      calls = 0,
      signal,
      options,
      release,
      allowed = false;
    const ui = await mount({
      onExit: () => {
        exits++;
      },
      submitPrompt: async (_input, inputOptions) => {
        calls++;
        options = inputOptions;
        signal = inputOptions.abortSignal;
        await new Promise((done) => {
          release = done;
        });
        return { response: "" };
      },
    });
    try {
      await submit(ui, "start");
      let permission;
      await act(async () => {
        permission = options
          .requestPermission(
            {
              requestId: "fixture-request",
              sessionId: "fixture-session",
              traceId: "fixture-trace",
              toolCallId: "fixture-call",
              toolName: question ? "AskUserQuestion" : "Bash",
              input: question
                ? {
                    questions: [
                      {
                        question: "Choose fixture",
                        header: "Fixture",
                        options: [
                          { label: "A", description: "first" },
                          { label: "B", description: "second" },
                        ],
                        multiSelect: false,
                      },
                    ],
                  }
                : { command: "echo fixture" },
              mode: "build",
              ruleId: "fixture-rule",
              reason: "fixture",
              riskLevel: "medium",
              requestedAt: new Date(),
            },
            { signal },
          )
          .then((result) => {
            allowed = result.decision === "allow";
          })
          .catch(() => {});
        await ui.flush();
      });
      if (typeof question === "string") {
        await act(async () => {
          ui.mockInput.pressKey("o");
          await ui.flush();
        });
        if (question === "other-path") {
          await submit(ui, "/tmp/fixture");
          assert.equal(exits, 0, "custom paths are answers, not quit gestures");
          assert.equal(signal.aborted, false);
        }
      }
      await submit(ui, "/quit");
      assert.equal(exits, 1, String(question));
      assert.equal(calls, 1);
      assert.equal(signal.aborted, true);
      assert.equal(allowed, false);
      await permission;
    } finally {
      await act(async () => {
        release?.();
        await ui.flush();
      });
      await destroy(ui);
    }
  }
  {
    let exits = 0;
    const submitted = [];
    const ui = await mount({
      onExit: () => {
        exits++;
      },
      submitPrompt: async (input) => {
        submitted.push(input);
        return { response: "" };
      },
    });
    try {
      for (const text of ["/quitfoo", "/quit args", "first\n/quit"]) await submit(ui, text);
      assert.equal(exits, 0);
      assert.ok(submitted.length >= 3);
      assert.ok(
        submitted.every((input) => (typeof input === "string" ? input : input.text) !== "/quit"),
        JSON.stringify(submitted),
      );
      await act(async () => {
        await ui.mockInput.typeText("/quit");
        ui.mockInput.pressEnter({ shift: true });
        await ui.flush();
      });
      assert.equal(exits, 0, "Shift+Enter is not quit");
    } finally {
      await destroy(ui);
    }
  }
  {
    let context,
      exits = 0,
      calls = 0;
    const controller = new AbortController();
    const ui = await mount({
      onExit: () => {
        exits++;
      },
      readClipboardImage: async () => ({
        dataUrl: "data:image/png;base64,ZmFrZQ==",
        mediaType: "image/png",
        sizeBytes: 4,
      }),
      submitPrompt: async (_input, options) => {
        calls++;
        context = options;
        return { response: "" };
      },
    });
    try {
      await submit(ui, "fixture metadata");
      await act(async () => {
        ui.mockInput.pressKey("v", { ctrl: true });
        await ui.flush();
      });
      await ui.renderOnce();
      assert.match(
        ui.captureCharFrame(),
        /image #1/,
        "main draft has an unsent fixture attachment",
      );
      await act(async () => {
        void context
          .requestPermission(
            {
              requestId: "attachment-gate",
              sessionId: "fixture",
              traceId: "fixture",
              toolCallId: "fixture",
              toolName: "Bash",
              input: { command: "echo fixture" },
              mode: "build",
              ruleId: "fixture",
              reason: "fixture",
              riskLevel: "medium",
              requestedAt: new Date(),
            },
            { signal: controller.signal },
          )
          .catch(() => {});
        await ui.flush();
      });
      await submit(ui, "/quit");
      assert.equal(exits, 1, "approval quit is separate from the main draft attachment");
      assert.equal(calls, 1, "attachment is not submitted while quitting");
    } finally {
      await act(async () => {
        controller.abort();
        await ui.flush();
      });
      await destroy(ui);
    }
  }
  await runBurstApprovalChecks({ mount, submit, act, destroy });
  console.log(
    "TUI /quit: en/zh completion, idle/no-model, busy abort, live approval/question, idempotence and boundaries passed.",
  );
} finally {
  await treeSitter.destroy();
  await rm(cache, { recursive: true, force: true });
}
