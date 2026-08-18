import { describe, expect, it, vi } from "vitest";

import type { PendingInteractionPort } from "../src/contracts/runtime/pending-interactions.js";
import { createPendingInteractionBinding } from "../src/services/runtime/pending-interaction-binding.js";

describe("pending interaction binding", () => {
  it("rejects calls before the container binds the coordinator", () => {
    const binding = createPendingInteractionBinding();
    expect(() => binding.port.waitForUserInput({
      sessionId: "s1",
      runId: "r1",
      rootRunId: "r1",
      parentRunId: null,
      parentCallId: null,
      toolCallId: "c1",
      deadlineMs: 1000,
      task: "t",
      prompt: "p",
    })).toThrow("used before the runtime container bound it");
    expect(() => binding.port.cancelSession("s1")).toThrow("used before the runtime container bound it");
  });

  it("forwards calls to the bound coordinator", async () => {
    const binding = createPendingInteractionBinding();
    const target: PendingInteractionPort = {
      onRootFinalized: vi.fn().mockResolvedValue(undefined),
      waitForUserInput: vi.fn().mockResolvedValue({ inputId: "i1", value: "yes", respondedAt: "now" }),
      waitForApproval: vi.fn().mockResolvedValue({ approvalId: "a1", approved: true, message: "", respondedAt: "now" }),
      cancelSession: vi.fn().mockResolvedValue(undefined),
    };
    binding.bind(target);

    const input = {
      sessionId: "s1",
      runId: "r1",
      rootRunId: "r1",
      parentRunId: null,
      parentCallId: null,
      toolCallId: "c1",
      deadlineMs: 1000,
      task: "t",
      prompt: "p",
    };
    await expect(binding.port.waitForUserInput(input)).resolves.toEqual({
      inputId: "i1",
      value: "yes",
      respondedAt: "now",
    });
    expect(target.waitForUserInput).toHaveBeenCalledWith(input);
    await binding.port.onRootFinalized("s1", "r1", "completed");
    expect(target.onRootFinalized).toHaveBeenCalledWith("s1", "r1", "completed");
  });
});
