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

test("Mistral, Groq, and Qwen use native tools when enabled", () => {
  for (const providerType of ["mistral", "groq", "qwen"]) {
    assert.equal(resolveToolInstructionMode(provider(providerType, true)), "native");
    assert.equal(resolveToolInstructionMode(provider(providerType, false)), "xml");
  }
});

test("Capability matrix keeps Anthropic native and unknown providers conservative", () => {
  assert.equal(resolveToolInstructionMode(provider("anthropic", false)), "native");
  assert.equal(resolveToolInstructionMode(provider("unknown", true)), "xml");
});
