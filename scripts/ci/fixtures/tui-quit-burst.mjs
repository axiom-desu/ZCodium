import assert from "node:assert/strict";

export async function runBurstApprovalChecks({ mount, submit, act, destroy }) {
  for (const decision of ["complete", "deny"]) {
    let context, release, result;
    const controller = new AbortController();
    const ui = await mount({
      onExit: () => {},
      submitPrompt: async (_input, options) => {
        context = options;
        await new Promise((done) => {
          release = done;
        });
        return { response: "" };
      },
    });
    try {
      await submit(ui, "start");
      await act(async () => {
        void context
          .requestPermission(
            {
              requestId: "burst",
              sessionId: "fixture",
              traceId: "fixture",
              toolCallId: "burst",
              toolName: "AskUserQuestion",
              input: {
                questions: [
                  {
                    question: "Burst fixture",
                    header: "Fixture",
                    options: [
                      { label: "A", description: "first" },
                      { label: "B", description: "second" },
                    ],
                    multiSelect: false,
                  },
                ],
              },
              mode: "build",
              ruleId: "fixture",
              reason: "fixture",
              riskLevel: "medium",
              requestedAt: new Date(),
            },
            { signal: controller.signal },
          )
          .then((value) => {
            result = value;
          })
          .catch(() => {});
        await ui.flush();
      });
      await act(async () => {
        ui.mockInput.pressKey("o");
        await ui.flush();
      });
      await act(async () => {
        for (const char of "/tmp/fixture") ui.mockInput.pressKey(char);
        if (decision === "complete") {
          ui.mockInput.pressEnter();
          ui.mockInput.pressEnter();
          ui.mockInput.pressEnter();
        } else {
          ui.mockInput.pressEscape();
          ui.mockInput.pressEscape();
        }
        await ui.flush();
      });
      assert.equal(
        result?.decision,
        decision === "complete" ? "modify" : "deny",
        "burst completion/cancel must use the latest approval state",
      );
      if (decision === "complete")
        assert.equal(result.modifiedInput.answers["Burst fixture"], "/tmp/fixture");
      await ui.renderOnce();
      assert.doesNotMatch(
        ui.captureCharFrame(),
        /Burst fixture/,
        "settled cloned approval must leave the queue",
      );
    } finally {
      await act(async () => {
        controller.abort();
        release?.();
        await ui.flush();
      });
      await destroy(ui);
    }
  }
}
