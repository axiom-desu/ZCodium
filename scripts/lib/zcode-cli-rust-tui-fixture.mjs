import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareHome } from "./zcode-cli-rust-interop-fixture.mjs";

/**
 * TUI 选择器/档位验收需要多个 typed 模型：首个模型保持既有单档位，
 * 其余模型提供多档推理，让 `/model` 过滤、下箭头选择与 `/effort` 都作用于真实 Registry 条目。
 */
export const TUI_MODELS = [
  { id: "model-a", levels: ["none"] },
  { id: "model-b", levels: ["none", "low", "high"] },
  { id: "model-c", levels: ["none", "low", "high"] },
];

/**
 * 明确 fixture 契约：PTY 侧按固定下标使用模型，缺项时不能回退到假单模型，
 * 否则选择器/档位断言会退化成对同一份假数据的自证。
 */
export function validateTuiModels(models = TUI_MODELS) {
  if (!Array.isArray(models) || models.length < 3)
    throw new Error("TUI fixture contract: at least three distinct models are required");
  const ids = new Set();
  for (const [index, model] of models.entries()) {
    if (typeof model?.id !== "string" || !model.id.trim())
      throw new Error(`TUI fixture contract: model[${index}] needs a non-empty id`);
    if (ids.has(model.id)) throw new Error(`TUI fixture contract: duplicate model id ${model.id}`);
    ids.add(model.id);
    if (!Array.isArray(model.levels) || model.levels.length === 0)
      throw new Error(`TUI fixture contract: ${model.id} needs at least one reasoning level`);
    const levels = new Set();
    for (const level of model.levels) {
      if (typeof level !== "string" || !level.trim())
        throw new Error(`TUI fixture contract: ${model.id} has an empty reasoning level`);
      if (levels.has(level))
        throw new Error(`TUI fixture contract: ${model.id} repeats reasoning level ${level}`);
      levels.add(level);
    }
  }
  if (ids.size < 3)
    throw new Error("TUI fixture contract: at least three distinct model ids are required");
  const down = models[2];
  if (down.levels.length < 2)
    throw new Error("TUI fixture contract: the down-arrow model needs multiple reasoning levels");
  if (down.levels[1] === down.levels.at(-1))
    throw new Error(
      "TUI fixture contract: the down-arrow model needs a non-default level to prove setter refresh",
    );
  return models;
}

/**
 * 复用 interop fixture 的隔离 HOME 与 loopback 模型，只把 personal Provider 的模型表
 * 扩成 TUI_MODELS；默认选择仍是 model-a/none，既有 smoke 语义不变。
 */
export async function prepareTuiHome(root, baseUrl) {
  validateTuiModels(TUI_MODELS);
  const env = await prepareHome(root, baseUrl);
  const file = join(root, "personal.json");
  const personal = JSON.parse(await readFile(file, "utf8"));
  const provider = personal.config.providerConfigRules.providerRules[0];
  provider.config.personalModelIds = TUI_MODELS.map((model) => model.id);
  personal.config.modelConfigRules.providerModelRules = TUI_MODELS.map((model) => ({
    providerId: provider.providerId,
    modelId: model.id,
    config: {
      properties: { contextWindow: 256000 },
      optionSpecs: { reasoningLevel: { values: model.levels, map: "{}" } },
    },
  }));
  await writeFile(file, JSON.stringify(personal));
  return env;
}
