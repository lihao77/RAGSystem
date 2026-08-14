import { describe, expect, it, vi } from "vitest";

import { runUserMessageTransformWithDeadline } from "../src/services/agent/execution/launchers.js";

const baseInput = {
  sessionId: "session-1",
  tenantId: "tenant-1",
  contentParts: [],
  attachments: [],
};

describe("runUserMessageTransformWithDeadline", () => {
  it("returns the transform result when it finishes within the deadline", async () => {
    const parts = [{ type: "text" as const, text: "transformed" }];
    const result = await runUserMessageTransformWithDeadline(
      async () => parts,
      baseInput,
    );
    expect(result).toEqual(parts);
  });

  it("falls back to null and aborts the in-flight call when the deadline is exceeded", async () => {
    vi.useFakeTimers();
    try {
      let receivedSignal: AbortSignal | null = null;
      const transform = vi.fn((input: { signal?: AbortSignal | null }) => {
        receivedSignal = input.signal ?? null;
        return new Promise<never>(() => undefined); // 永不 settle，模拟挂起的视觉调用
      });
      const pending = runUserMessageTransformWithDeadline(transform as never, baseInput as never);
      await vi.advanceTimersByTimeAsync(4001);
      const result = await pending;
      expect(result).toBeNull();
      expect(receivedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates an early transform rejection", async () => {
    await expect(runUserMessageTransformWithDeadline(
      async () => { throw new Error("transform boom"); },
      baseInput,
    )).rejects.toThrow("transform boom");
  });
});
