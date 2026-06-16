import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { RuntimeToolApprovalDecision } from "../../src/services/runtime/permission-policy-service.js";
import type { RuntimeToolExecutionContext } from "../../src/services/runtime/runtime-tool-types.js";
import { buildTool } from "../../src/services/runtime/tools/tool.js";
import { partitionToolCalls } from "../../src/services/runtime/tools/tool-scheduler.js";
import {
  applyHookPermissionDecision,
  denyPermissionResult,
  isToolPermissionForceAsk,
  mergeToolPermissionMetadata,
} from "../../src/services/runtime/tools/tool-permissions.js";
import { validateToolInput } from "../../src/services/runtime/tools/validation.js";

describe("runtime tools", () => {
  it("partitions consecutive concurrency-safe calls and breaks on unsafe calls", () => {
    const calls = [
      { index: 0, arguments: {}, safe: true },
      { index: 1, arguments: {}, safe: true },
      { index: 2, arguments: {}, safe: false },
      { index: 3, arguments: {}, safe: true },
      { index: 4, arguments: {}, safe: true },
    ];

    expect(partitionToolCalls(calls, (call) => call.safe, 2)).toEqual([
      { parallel: true, calls: calls.slice(0, 2) },
      { parallel: false, calls: [calls[2]] },
      { parallel: true, calls: calls.slice(3, 5) },
    ]);
  });

  it("returns structured validation errors from the Zod input schema", () => {
    const tool = buildTool({
      name: "read_file",
      description: "Read file",
      inputSchema: z.object({ file_path: z.string() }).strict(),
      call: () => {
        throw new Error("call should not be reached after validation failure");
      },
    });

    const validation = validateToolInput(tool, {
      toolName: "read_file",
      arguments: { file_path: 123 },
    });

    expect(validation).toMatchObject({
      ok: false,
      result: {
        success: false,
        tool_name: "read_file",
        output_type: "error",
        metadata: {
          error_type: "InputValidationError",
          issues: [
            expect.objectContaining({
              path: "file_path",
            }),
          ],
        },
      },
    });
  });
});

function approvalDecision(overrides: Partial<RuntimeToolApprovalDecision> = {}): RuntimeToolApprovalDecision {
  return {
    action: "allow",
    toolName: "execute_bash",
    riskLevel: "high",
    description: "Execute bash",
    permissionMode: "standard",
    reason: "policy reason",
    reasonCodes: [],
    secondaryReasons: [],
    approvedExternalPaths: [],
    ...overrides,
  };
}

function emptyResult(name: string) {
  return {
    success: true,
    tool_name: name,
    summary: "",
    answer: null,
    output_type: "text",
    content: "",
    metadata: {},
    artifacts: [],
    llm_hint: null,
  };
}

describe("tool permissions", () => {
  describe("applyHookPermissionDecision", () => {
    it("upgrades an ask decision to allow when the hook allows", () => {
      const result = applyHookPermissionDecision(
        approvalDecision({ action: "ask" }),
        { continueExecution: true, blockExecution: false, blockReason: "", permissionDecision: "allow" },
        "execute_bash",
        "high",
      );
      expect(result?.action).toBe("allow");
      expect(result?.reason).toBe("hook permission decision: allow");
    });

    it("downgrades an allow decision to ask when the hook asks", () => {
      const result = applyHookPermissionDecision(
        approvalDecision({ action: "allow" }),
        { continueExecution: true, blockExecution: false, blockReason: "", permissionDecision: "ask", uiMessage: "hook asks" },
        "execute_bash",
        "high",
      );
      expect(result?.action).toBe("ask");
      expect(result?.reasonCodes).toContain("ask-hook");
    });

    it("builds a default decision when none existed and the hook asks", () => {
      const result = applyHookPermissionDecision(
        undefined,
        { continueExecution: true, blockExecution: false, blockReason: "", permissionDecision: "ask", uiMessage: "hook asks" },
        "execute_bash",
        "high",
      );
      expect(result?.action).toBe("ask");
      expect(result?.toolName).toBe("execute_bash");
      expect(result?.riskLevel).toBe("high");
    });

    it("returns the original decision reference when the hook has no permission decision", () => {
      const decision = approvalDecision({ action: "allow" });
      const result = applyHookPermissionDecision(
        decision,
        { continueExecution: true, blockExecution: false, blockReason: "" },
        "execute_bash",
        "high",
      );
      expect(result).toBe(decision);
    });

    it("returns the original decision when the hook decides deny (deny is handled via blockExecution)", () => {
      const decision = approvalDecision({ action: "allow" });
      const result = applyHookPermissionDecision(
        decision,
        { continueExecution: true, blockExecution: false, blockReason: "", permissionDecision: "deny" },
        "execute_bash",
        "high",
      );
      expect(result).toBe(decision);
    });
  });

  describe("isToolPermissionForceAsk", () => {
    it("returns true only for the ask behavior", () => {
      expect(isToolPermissionForceAsk({ behavior: "ask" })).toBe(true);
      expect(isToolPermissionForceAsk({ behavior: "allow" })).toBe(false);
      expect(isToolPermissionForceAsk({ behavior: "deny" })).toBe(false);
      expect(isToolPermissionForceAsk(null)).toBe(false);
    });
  });

  describe("denyPermissionResult", () => {
    it("builds an error result carrying the tool_permission metadata", () => {
      const result = denyPermissionResult("execute_bash", {
        behavior: "deny",
        reason: "destructive command",
        metadata: { command_class: "destructive" },
      });
      expect(result.success).toBe(false);
      expect(result.tool_name).toBe("execute_bash");
      expect(result.metadata).toMatchObject({
        tool_permission: {
          behavior: "deny",
          reason: "destructive command",
          command_class: "destructive",
        },
      });
    });

    it("falls back to a default reason when the permission carries none", () => {
      const result = denyPermissionResult("execute_bash", { behavior: "deny" });
      expect(result.summary).toContain("execute_bash");
      expect(result.metadata).toMatchObject({
        tool_permission: { behavior: "deny", reason: "" },
      });
    });
  });

  describe("mergeToolPermissionMetadata", () => {
    it("merges tool_permission under existing metadata", () => {
      const merged = mergeToolPermissionMetadata({ foo: 1 }, { behavior: "ask", reason: "r" });
      expect(merged).toEqual({
        foo: 1,
        tool_permission: { behavior: "ask", reason: "r" },
      });
    });

    it("returns the original metadata when permission is null", () => {
      expect(mergeToolPermissionMetadata({ foo: 1 }, null)).toEqual({ foo: 1 });
    });
  });

  describe("buildTool permission gate", () => {
    it("defaults allowedCallers to direct-only so code_execution is rejected at the tool level", () => {
      const directOnly = buildTool({
        name: "direct_tool",
        description: "direct only",
        inputSchema: z.object({}).strict(),
        call: () => emptyResult("direct_tool"),
      });
      expect(directOnly.allowedCallers).toEqual(["direct"]);
      expect(directOnly.allowedCallers.includes("code_execution")).toBe(false);

      const callableFromCode = buildTool({
        name: "callable",
        description: "callable",
        allowedCallers: ["direct", "code_execution"],
        inputSchema: z.object({}).strict(),
        call: () => emptyResult("callable"),
      });
      expect(callableFromCode.allowedCallers).toEqual(["direct", "code_execution"]);
    });

    it("lets a tool deny through checkPermissions (first layer of the three-layer gate)", () => {
      const tool = buildTool({
        name: "gated",
        description: "gated",
        inputSchema: z.object({}).strict(),
        checkPermissions: () => ({ behavior: "deny", reason: "tool-level deny" }),
        call: () => emptyResult("gated"),
      });
      const decision = tool.checkPermissions!({} as Record<string, unknown>, {} as RuntimeToolExecutionContext);
      expect(decision.behavior).toBe("deny");
      expect(isToolPermissionForceAsk(decision)).toBe(false);
    });

    it("treats a tool-level ask as a force-ask", () => {
      const tool = buildTool({
        name: "gated",
        description: "gated",
        inputSchema: z.object({}).strict(),
        checkPermissions: () => ({ behavior: "ask", reason: "tool wants approval" }),
        call: () => emptyResult("gated"),
      });
      const decision = tool.checkPermissions!({} as Record<string, unknown>, {} as RuntimeToolExecutionContext);
      expect(isToolPermissionForceAsk(decision)).toBe(true);
    });
  });
});
