import assert from "node:assert/strict";
import test from "node:test";

import { resolveToolInstructionMode } from "../dist/index.js";

const provider = (providerType, supportsFunctionCalling) => ({
  key: providerType,
  name: providerType,
  provider_type: providerType,
  supports_function_calling: supportsFunctionCalling,
});

test("Gemini selects native tools only when function calling is enabled", () => {
  assert.equal(resolveToolInstructionMode(provider("gemini", true)), "native");
  assert.equal(resolveToolInstructionMode(provider("gemini", false)), "xml");
});

test("OpenAI 兼容网关经 openai_chat 格式选择 native；裸厂商类型保守回退 xml", () => {
  // 厂商类型不再参与协议分派：运行时经 api_format 桥接为 openai_chat 后选择 native。
  assert.equal(resolveToolInstructionMode(provider("openai_chat", true)), "native");
  assert.equal(resolveToolInstructionMode(provider("openai_chat", false)), "xml");
  // 未经桥接的裸厂商类型（mistral/groq/qwen）不在封闭格式清单内，保守回退 xml。
  for (const providerType of ["mistral", "groq", "qwen"]) {
    assert.equal(resolveToolInstructionMode(provider(providerType, true)), "xml");
    assert.equal(resolveToolInstructionMode(provider(providerType, false)), "xml");
  }
});

test("Capability matrix keeps Anthropic native and unknown providers conservative", () => {
  assert.equal(resolveToolInstructionMode(provider("anthropic", false)), "native");
  assert.equal(resolveToolInstructionMode(provider("unknown", true)), "xml");
});
