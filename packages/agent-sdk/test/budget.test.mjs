import assert from "node:assert/strict";
import test from "node:test";

import { resolveContextBudget } from "../dist/llm-params/budget.js";

const tier = (maxContextTokens) => ({
  default: {
    provider: {},
    modelName: "model",
    temperature: null,
    maxCompletionTokens: null,
    maxContextTokens,
    extraParams: {},
  },
});

test("上下文预算 = window×0.9 − systemPromptTokens", () => {
  assert.equal(resolveContextBudget(tier(128000), 7519), 107681);
});

test("窗口缺失或预算为负时使用内置兜底", () => {
  assert.equal(resolveContextBudget(tier(1000), 5000), 4000);
  assert.equal(resolveContextBudget(tier(null), 5000), 4000);
  assert.equal(resolveContextBudget({}, 5000), 4000);
});
