import { describe, expect, it, vi } from "vitest";

import type { PendingInteractionNotice, PendingInteractionPort } from "../src/contracts/runtime/pending-interactions.js";
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
      onInteractionRequired: vi.fn().mockReturnValue(() => undefined),
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

  it("supports subscribing to interaction notices before bind and replays them onto the coordinator", () => {
    const binding = createPendingInteractionBinding();
    const notices: PendingInteractionNotice[] = [];
    const unsubscribe = binding.port.onInteractionRequired((notice) => notices.push(notice));

    // bind 前订阅不抛错（观察型例外）；bind 后转挂到真实协调器
    const realUnsubscribe = vi.fn();
    const target: PendingInteractionPort = {
      onRootFinalized: vi.fn().mockResolvedValue(undefined),
      waitForUserInput: vi.fn(),
      waitForApproval: vi.fn(),
      cancelSession: vi.fn().mockResolvedValue(undefined),
      onInteractionRequired: vi.fn().mockReturnValue(realUnsubscribe),
    };
    binding.bind(target);
    expect(target.onInteractionRequired).toHaveBeenCalledTimes(1);

    // bind 后新订阅直接透传；退订走真实协调器的退订函数
    const unsubscribeLate = binding.port.onInteractionRequired(() => undefined);
    expect(target.onInteractionRequired).toHaveBeenCalledTimes(2);
    unsubscribeLate();
    expect(realUnsubscribe).toHaveBeenCalledTimes(1);

    // bind 前的订阅退订同样生效（本地集合移除，不再转挂）
    unsubscribe();
    expect(realUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
