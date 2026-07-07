import { describe, expect, it } from "vitest";

import { getSelectedLlm, ExecuteRequestSchema, StreamExecuteRequestSchema } from "../../src/contracts/execution.js";

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

  it("ExecuteRequest 拒绝 attachments/ui_context(/execute 不支持附件,显式 never)", () => {
    // 误传 attachments(任何值)→ ZodError(全局 handler 返回 400),而非静默 strip
    expect(() => ExecuteRequestSchema.parse({ task: "hi", attachments: [{ file_id: "x" }] })).toThrow();
    expect(() => ExecuteRequestSchema.parse({ task: "hi", attachments: [] })).toThrow();
    expect(() => ExecuteRequestSchema.parse({ task: "hi", ui_context: { a: 1 } })).toThrow();
    // 字段缺失/agent 正常:OK
    const ok = ExecuteRequestSchema.parse({ task: "hi", agent: "a" });
    expect(ok.task).toBe("hi");
    expect(ok.agent).toBe("a");
  });
});
