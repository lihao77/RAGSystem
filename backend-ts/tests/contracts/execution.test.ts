import { describe, expect, it } from "vitest";

import { getSelectedLlm, StreamExecuteRequestSchema } from "../../src/contracts/execution.js";

describe("execution contracts", () => {
  it("keeps the selectedLLM alias used by the frontend", () => {
    const parsed = StreamExecuteRequestSchema.parse({
      task: "hello",
      selectedLLM: "openai|openai_chat|gpt",
    });

    expect(getSelectedLlm(parsed)).toBe("openai|openai_chat|gpt");
  });

  it("defaults task and attachments to Python-compatible empty values", () => {
    const parsed = StreamExecuteRequestSchema.parse({});

    expect(parsed.task).toBe("");
    expect(parsed.attachments).toEqual([]);
  });
});
