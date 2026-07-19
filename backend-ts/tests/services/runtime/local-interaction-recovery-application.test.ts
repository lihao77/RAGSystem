import { describe, expect, it, vi } from "vitest";

import { LocalInteractionRecoveryApplication } from "../../../src/adapters/local/application/interaction-recovery/local-interaction-recovery-application.js";

describe("LocalInteractionRecoveryApplication", () => {
  it("adapts process-local interaction and continuation stores to the async contract", async () => {
    const pending = {
      respondApproval: vi.fn(() => ({
        resolved: true,
        needsResume: false,
        kind: "approval" as const,
        interactionId: "approval-1",
      })),
      respondUserInput: vi.fn(() => ({
        resolved: true,
        needsResume: true,
        kind: "user_input" as const,
        interactionId: "input-1",
      })),
    };
    const continuation = {
      session_id: "session-1",
      message_id: "message-1",
      provider: "test",
      model: "test-model",
      state: { response_id: "response-1" },
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const conversations = { getProviderContinuation: vi.fn(() => continuation) };
    const application = new LocalInteractionRecoveryApplication(pending, conversations as never);

    await expect(application.respondApproval("session-1", "approval-1", {
      approved: true,
      message: "continue",
    })).resolves.toMatchObject({ resolved: true, kind: "approval" });
    await expect(application.respondUserInput("session-1", "input-1", {
      value: "answer",
    })).resolves.toMatchObject({ resolved: true, needsResume: true });
    await expect(application.getProviderContinuation("session-1", "message-1")).resolves.toBe(continuation);
  });
});
