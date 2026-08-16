import { describe, expect, it } from "vitest";

import { parseRunAgentInput } from "../src/services/agui-gateway/agui-input.js";
import type { RunAgentInput } from "../src/services/agui-gateway/agui-input.js";

describe("parseRunAgentInput thinkingLevel", () => {
  it("accepts all eight thinking levels", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "on"]) {
      const input = parseRunAgentInput({ thinkingLevel: level });
      expect(input.thinkingLevel).toBe(level);
    }
  });

  it("drops unknown thinking levels instead of preserving them", () => {
    const input = parseRunAgentInput({ thinkingLevel: "ultra" });
    expect(input.thinkingLevel).toBeUndefined();
  });

  it("keeps other extension fields intact", () => {
    const input = parseRunAgentInput({ thinkingLevel: "max", selectedLlm: "m1", threadId: "t1" });
    const expected: RunAgentInput = { thinkingLevel: "max", selectedLlm: "m1", threadId: "t1" };
    expect(input).toEqual(expected);
  });
});
