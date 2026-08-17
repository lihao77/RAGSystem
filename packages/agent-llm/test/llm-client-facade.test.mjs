import assert from "node:assert/strict";
import test from "node:test";

import { LlmProviderClient, OpenAiCompatibleClient } from "../dist/index.js";
import { LlmProviderClient as DirectLlmProviderClient } from "../dist/llm-client.js";
import { OpenAiCompatibleClient as DirectLegacyClient } from "../dist/openai-compatible-client.js";

test("the semantic facade is canonical while the historical client name remains compatible", () => {
  assert.equal(DirectLlmProviderClient, LlmProviderClient);
  assert.equal(OpenAiCompatibleClient, DirectLegacyClient);
  assert.equal(OpenAiCompatibleClient.name, "OpenAiCompatibleClient");
  assert.equal(new OpenAiCompatibleClient() instanceof LlmProviderClient, true);
});
