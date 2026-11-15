// 输入预测 sidecar 纯函数与编排壳。
// 规格：.agents/specs/upstream-3.18-input-prediction.md。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { v4ConversationInputPredictionResultSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  INPUT_PREDICTION_QUERY_SOURCE,
  buildInputPredictionContext,
  buildInputPredictionMessages,
  decideInputPrediction,
  generateInputPredictionCandidates,
  inputPredictionMinTurns,
  normalizeInputPredictionDraft,
  parseInputPredictionResponse,
  toInputPredictionSuffix,
  type InputPredictionModelCall,
  type InputPredictionTurnContext,
} from "../src/runtime/methods/input-prediction-sidecar.js";

const turns: InputPredictionTurnContext[] = [
  { userText: "帮我看下 lint 报错", assistantText: "已修复 3 处" },
  { userText: "再跑一遍单测", assistantText: "全部通过" },
];

describe("parseInputPredictionResponse", () => {
  it("解析纯 JSON", () => {
    assert.deepEqual(
      parseInputPredictionResponse('{"candidates":[{"text":"提交吧","confidence":0.9}]}'),
      [{ text: "提交吧", confidence: 0.9 }],
    );
  });

  it("容忍 think 段、code fence、尾逗号与前后说明", () => {
    const raw =
      '<think>想一想</think>\n```json\n{"candidates":[{"text":"提交吧","confidence":0.9},]}\n```';
    assert.deepEqual(parseInputPredictionResponse(raw), [{ text: "提交吧", confidence: 0.9 }]);
    assert.deepEqual(
      parseInputPredictionResponse('结果如下：{"candidates":[{"text":"好","confidence":0.5}]} 完'),
      [{ text: "好", confidence: 0.5 }],
    );
  });

  it("结构不对或没有有效候选时返回 null", () => {
    assert.equal(parseInputPredictionResponse("不是 JSON"), null);
    assert.equal(parseInputPredictionResponse('{"candidates":[]}'), null);
    assert.equal(parseInputPredictionResponse('{"candidates":[{"text":1,"confidence":0.9}]}'), null);
    assert.equal(parseInputPredictionResponse("[]"), null);
  });
});

describe("toInputPredictionSuffix", () => {
  it("无草稿时单行化并两端 trim", () => {
    assert.equal(toInputPredictionSuffix("  提交\n代码  ", ""), "提交 代码");
  });

  it("有草稿时剥掉模型重复的草稿前缀，保留续写开头的空格", () => {
    assert.equal(toInputPredictionSuffix("run the tests", "run the"), " tests");
    assert.equal(toInputPredictionSuffix(" tests  ", "run the"), " tests");
  });

  it("草稿以空白结尾时续写不再以空白开头", () => {
    assert.equal(toInputPredictionSuffix("run the tests", "run the "), "tests");
    assert.equal(toInputPredictionSuffix("  tests", "run the "), "tests");
  });

  it("按 UTF-16 长度截断到 40，不劈开代理对", () => {
    assert.equal(toInputPredictionSuffix("好".repeat(50), "").length, 40);
    const bounded = toInputPredictionSuffix("😀".repeat(30), "");
    assert.ok(bounded.length <= 40);
    assert.equal(bounded, "😀".repeat(20));
  });
});

describe("decideInputPrediction", () => {
  it("轮数不够时 suppress_no_context", () => {
    assert.deepEqual(
      decideInputPrediction({
        rawCandidates: [{ text: "好", confidence: 1 }],
        draft: "",
        recentUserInputs: ["a"],
        turnCount: 1,
      }),
      { decision: "suppress_no_context", candidates: [], topConfidence: 0 },
    );
    assert.equal(inputPredictionMinTurns("草稿"), 1);
    assert.equal(inputPredictionMinTurns(""), 2);
  });

  it("去掉与最近用户输入重复的、候选间重复的，按置信度降序取前 3", () => {
    const outcome = decideInputPrediction({
      rawCandidates: [
        { text: "再跑一遍 单测", confidence: 0.99 },
        { text: "提交代码", confidence: 0.7 },
        { text: "提交 代码", confidence: 0.85 },
        { text: "推送", confidence: 0.6 },
        { text: "看下覆盖率", confidence: 0.5 },
        { text: "合并", confidence: 0.4 },
        { text: "   ", confidence: 0.95 },
      ],
      draft: "",
      recentUserInputs: turns.map((turn) => turn.userText),
      turnCount: 2,
    });
    assert.deepEqual(outcome, {
      decision: "show",
      candidates: [
        { text: "提交 代码", confidence: 0.85 },
        { text: "推送", confidence: 0.6 },
        { text: "看下覆盖率", confidence: 0.5 },
      ],
      topConfidence: 0.85,
    });
    assert.equal(
      v4ConversationInputPredictionResultSchema.safeParse({ ...outcome, requestId: "r" }).success,
      true,
    );
  });

  it("top 置信度不到门槛时 suppress_below_threshold；置信度被夹到 0..1", () => {
    assert.equal(
      decideInputPrediction({
        rawCandidates: [{ text: "提交", confidence: 0.79 }],
        draft: "",
        recentUserInputs: [],
        turnCount: 3,
      }).decision,
      "suppress_below_threshold",
    );
    assert.deepEqual(
      decideInputPrediction({
        rawCandidates: [{ text: "提交", confidence: 3 }],
        draft: "",
        recentUserInputs: [],
        turnCount: 3,
      }),
      { decision: "show", candidates: [{ text: "提交", confidence: 1 }], topConfidence: 1 },
    );
  });

  it("草稿模式按「草稿 + 续写」与最近输入去重", () => {
    assert.deepEqual(
      decideInputPrediction({
        rawCandidates: [{ text: "单测", confidence: 0.9 }],
        draft: "再跑一遍",
        recentUserInputs: ["再跑一遍单测"],
        turnCount: 1,
      }).candidates,
      [],
    );
  });
});

describe("上下文与提示词", () => {
  it("只取最近 6 轮，助手回复截断，总预算从最旧处截断", () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      userText: `问题${index}`,
      assistantText: index === 7 ? "长".repeat(900) : null,
    }));
    const context = buildInputPredictionContext(many);
    assert.equal(context.includes("问题1"), false);
    assert.equal(context.includes("问题2"), true);
    assert.equal(context.includes("（无回复）"), true);
    assert.equal(context.includes(`${"长".repeat(800)}…`), true);
    assert.equal(buildInputPredictionContext(many, { totalMaxChars: 20 }).length, 20);
  });

  it("草稿模式换提示词并附草稿；纯空白草稿视为无草稿", () => {
    assert.equal(normalizeInputPredictionDraft("   "), "");
    assert.equal(normalizeInputPredictionDraft(undefined), "");
    const [system, user] = buildInputPredictionMessages(turns, "帮我");
    assert.match(system!.content, /输入补全器/u);
    assert.match(user!.content, /【用户正在输入的草稿】\n帮我/u);
    assert.match(buildInputPredictionMessages(turns, "")[0]!.content, /输入预测器/u);
  });
});

describe("generateInputPredictionCandidates", () => {
  it("用 input_prediction querySource 调模型并解析", async () => {
    let seenQuerySource: string | undefined;
    const callModel: InputPredictionModelCall = async (_messages, options) => {
      seenQuerySource = options.querySource;
      return { text: '{"candidates":[{"text":"提交","confidence":0.9}]}' };
    };
    assert.deepEqual(await generateInputPredictionCandidates({ turns, draft: "", callModel }), [
      { text: "提交", confidence: 0.9 },
    ]);
    assert.equal(seenQuerySource, INPUT_PREDICTION_QUERY_SOURCE);
  });

  it("外部取消时立即放弃等待，即使模型执行面不响应 signal", async () => {
    const controller = new AbortController();
    const pending = generateInputPredictionCandidates({
      turns,
      draft: "",
      callModel: () => new Promise(() => undefined),
      abortSignal: controller.signal,
    });
    controller.abort(new Error("superseded"));
    await assert.rejects(pending, /superseded/u);
  });

  it("超时后拒绝，并把合并后的 signal 交给模型执行面", async () => {
    let seen: AbortSignal | undefined;
    const pending = generateInputPredictionCandidates({
      turns,
      draft: "",
      timeoutMs: 10,
      callModel: (_messages, options) => {
        seen = options.abortSignal;
        return new Promise(() => undefined);
      },
    });
    await assert.rejects(pending);
    assert.equal(seen?.aborted, true);
  });
});
