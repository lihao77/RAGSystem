import { describe, expect, it } from "vitest";

import { HookRuntimeService } from "../../src/services/runtime/hooks/index.js";

describe("HookRuntimeService", () => {
  it("matches hooks by event, priority, matcher, and merges metadata", async () => {
    const hooks = new HookRuntimeService({ enabled: false });
    const order: string[] = [];
    hooks.registerHandler("test:first", ({ context }) => {
      order.push(`first:${context.toolName}:${context.inputSnapshot.value}`);
      return {
        continueExecution: true,
        blockExecution: false,
        blockReason: "",
        tags: ["first"],
        metadata: { first: true },
      };
    });
    hooks.registerHandler("test:second", () => {
      order.push("second");
      return {
        continueExecution: true,
        blockExecution: false,
        blockReason: "",
        tags: ["second"],
        metadata: { second: true },
      };
    });
    hooks.registerHook({
      id: "second",
      name: "Second",
      priority: 10,
      events: ["tool.before_execute"],
      matcher: { toolNames: ["write_file"] },
      backend: { type: "function", target: "test:second" },
    });
    hooks.registerHook({
      id: "first",
      name: "First",
      priority: 20,
      events: ["tool.before_execute"],
      matcher: { toolNames: ["write_file"] },
      backend: { type: "function", target: "test:first" },
    });

    const result = await hooks.runToolHook("tool.before_execute", {
      toolName: "write_file",
      tool: { riskLevel: "medium", source: "document" },
      call: { toolName: "write_file", arguments: { value: "alpha" } },
      context: {
        agent: null,
        sessionId: "session-1",
      },
    });

    expect(order).toEqual(["first:write_file:alpha", "second"]);
    expect(result.tags).toEqual(["first", "second"]);
    expect(result.metadata).toEqual({ first: true, second: true });
  });

  it("supports workspace trust rules and blocking hooks", async () => {
    const hooks = new HookRuntimeService({
      enabled: false,
      workspaceTrust: {
        default: "trusted",
        rules: [{ workspaceRootPrefix: "E:/tmp/untrusted", trust: "untrusted" }],
      },
    });
    hooks.registerHandler("test:block-untrusted", ({ context }) => ({
      continueExecution: context.workspaceTrust !== "untrusted",
      blockExecution: context.workspaceTrust === "untrusted",
      blockReason: "untrusted workspace",
      metadata: { workspace_trust: context.workspaceTrust },
    }));
    hooks.registerHook({
      id: "block-untrusted",
      name: "Block Untrusted",
      events: ["tool.before_execute"],
      matcher: { workspaceTrust: ["untrusted"] },
      backend: { type: "function", target: "test:block-untrusted" },
    });

    const result = await hooks.runToolHook("tool.before_execute", {
      toolName: "execute_bash",
      tool: { riskLevel: "high", source: "execution" },
      call: { toolName: "execute_bash", arguments: { command: "echo ok" } },
      context: {
        agent: null,
        workspaceRoot: "E:/tmp/untrusted/project",
      },
    });

    expect(result.blockExecution).toBe(true);
    expect(result.blockReason).toBe("untrusted workspace");
    expect(result.metadata).toEqual({ workspace_trust: "untrusted" });
  });
});
