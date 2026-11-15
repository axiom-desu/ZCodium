// 手机远控输入预测的 Host 总开关：hello cap 与服务门禁共用同一判定。
// 规格：.agents/specs/upstream-3.18-input-prediction.md。
import assert from "node:assert/strict";
import test from "node:test";

import {
  REMOTE_INPUT_PREDICTION_DEFAULT_ENABLED,
  REMOTE_INPUT_PREDICTION_ENV,
  isRemoteInputPredictionEnabled,
} from "../src/zcode-agent/inputPredictionSwitch.js";

test("未设置或空白默认开启；显式 1 开启；其它值关闭", () => {
  assert.equal(REMOTE_INPUT_PREDICTION_DEFAULT_ENABLED, true);
  assert.equal(REMOTE_INPUT_PREDICTION_ENV, "ZCODE_REMOTE_INPUT_PREDICTION");
  assert.equal(isRemoteInputPredictionEnabled({}), true);
  assert.equal(isRemoteInputPredictionEnabled({ [REMOTE_INPUT_PREDICTION_ENV]: "" }), true);
  assert.equal(isRemoteInputPredictionEnabled({ [REMOTE_INPUT_PREDICTION_ENV]: "  " }), true);
  assert.equal(isRemoteInputPredictionEnabled({ [REMOTE_INPUT_PREDICTION_ENV]: "1" }), true);
  assert.equal(isRemoteInputPredictionEnabled({ [REMOTE_INPUT_PREDICTION_ENV]: " 1 " }), true);
  assert.equal(isRemoteInputPredictionEnabled({ [REMOTE_INPUT_PREDICTION_ENV]: "0" }), false);
  assert.equal(isRemoteInputPredictionEnabled({ [REMOTE_INPUT_PREDICTION_ENV]: "true" }), false);
});
