import type { AgentConfig } from "../../contracts/agent-config.js";
import type { MemoryToolService } from "../../tools/MemoryTools/MemoryExecution.js";
import type { LocalDocumentToolService } from "../../tools/DocumentTools/DocumentExecution.js";
import type { CodeExecutionToolService } from "../../tools/CodeExecutionTool/CodeExecution.js";
import type { DelegationPort } from "../agent/delegation/port.js";
import type { TaskToolService } from "../../tools/TaskTools/TaskExecution.js";
import type { LocalSearchToolService } from "../../tools/LocalSearchTools/SearchExecution.js";
import type { SkillToolService } from "../../tools/SkillTools/SkillExecution.js";
import type { VectorLibraryService } from "../knowledge/vector-library-service.js";
import type { McpService } from "../integrations/mcp-service.js";
import type { LocalBashToolService } from "../../tools/BashTool/BashExecution.js";
import type {
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolExecutionContext,
  RuntimeToolExecutor,
  ToolExecutionResult,
  RuntimeToolWaitRequest,
  RuntimeToolWaitResult,
} from "./runtime-tool-types.js";
import type { PendingInteractionService } from "./pending-interaction-service.js";
import type {
  PermissionPolicyService,
  RuntimeToolApprovalDecision,
} from "./permission-policy-service.js";
import { throwIfAborted } from "@ragsystem/agent-protocol";
import type { HookRuntimeService, HookResult } from "./hooks/index.js";
import { withApprovalMetadata, withApprovedExternalPaths } from "./runtime-tool-bridge/arguments.js";
import {
  executeToolCall,
  isToolResult,
  ToolPreparer,
  type PreparedRuntimeTool,
} from "./runtime-tool-bridge/prepared.js";
import { ToolApprovalCoordinator } from "./runtime-tool-bridge/approval.js";
import { ToolHookOrchestrator } from "./runtime-tool-bridge/hooks-orchestrator.js";
import { createToolRegistry, type RuntimeToolRegistry } from "../../tools/registry.js";
import { toolToDefinition } from "../../tools/Tool.js";
import { applyHookPermissionDecision } from "../../tools/permissions.js";

export { isReadOnlyMemoryToolName } from "./runtime-tool-bridge/arguments.js";

/** RuntimeToolBridge 的具名依赖。memoryTools 必填,其余按需注入(未注入即该能力不可用)。 */
export interface RuntimeToolBridgeDeps {
  memoryTools: MemoryToolService;
  pendingInteractions?: PendingInteractionService | null;
  permissionPolicy?: PermissionPolicyService | null;
  documentTools?: LocalDocumentToolService | null;
  bashTools?: LocalBashToolService | null;
  taskTools?: TaskToolService | null;
  searchTools?: LocalSearchToolService | null;
  hooks?: HookRuntimeService | null;
  vectorLibrary?: VectorLibraryService | null;
  mcp?: McpService | null;
  codeExecutionTools?: CodeExecutionToolService | null;
  skillTools?: SkillToolService | null;
}

/**
 * 工具桥:面向运行时内核的工具门面。自身只做"注册表门面 + 执行编排",
 * 准备/审批/Hook 三簇职责分别下沉到 ToolPreparer / ToolApprovalCoordinator / ToolHookOrchestrator。
 */
export class RuntimeToolBridge implements RuntimeToolExecutor {
  private agentDelegation: DelegationPort | null = null;
  /** 暴露内部注册表供 SDK ToolRegistry 适配层使用。 */
  readonly toolRegistry: RuntimeToolRegistry;
  private readonly preparer: ToolPreparer;
  private readonly approval: ToolApprovalCoordinator;
  private readonly hookOrchestrator: ToolHookOrchestrator;
  private readonly taskTools: TaskToolService | null;

  constructor(deps: RuntimeToolBridgeDeps) {
    this.taskTools = deps.taskTools ?? null;
    this.toolRegistry = createToolRegistry({
      memoryTools: deps.memoryTools,
      pendingInteractions: deps.pendingInteractions ?? null,
      documentTools: deps.documentTools ?? null,
      bashTools: deps.bashTools ?? null,
      taskTools: deps.taskTools ?? null,
      searchTools: deps.searchTools ?? null,
      vectorLibrary: deps.vectorLibrary ?? null,
      mcp: deps.mcp ?? null,
      codeExecutionTools: deps.codeExecutionTools ?? null,
      skillTools: deps.skillTools ?? null,
      getAgentDelegation: () => this.agentDelegation,
    });
    this.preparer = new ToolPreparer(this.toolRegistry);
    this.approval = new ToolApprovalCoordinator(deps.permissionPolicy ?? null, deps.pendingInteractions ?? null);
    this.hookOrchestrator = new ToolHookOrchestrator(deps.hooks ?? null);
  }

  setAgentDelegation(agentDelegation: DelegationPort | null): void {
    this.agentDelegation = agentDelegation;
  }

  listVisibleTools(agent: AgentConfig | null): RuntimeToolDefinition[] {
    return this.toolRegistry.listDefinitions(agent);
  }

  listVisibleToolNames(agent: AgentConfig | null): string[] {
    return this.listVisibleTools(agent).map((tool) => tool.name);
  }

  canExecuteTool(toolName: string, agent: AgentConfig | null): boolean {
    return this.listVisibleToolNames(agent).includes(toolName);
  }

  classifyConcurrency(call: RuntimeToolCall, context: RuntimeToolExecutionContext): boolean {
    return this.toolRegistry.classifyConcurrency(call, context);
  }

  executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext): ToolExecutionResult | Promise<ToolExecutionResult> {
    throwIfAborted(context.signal, "Tool execution aborted");
    const prepared = this.preparer.prepare(call, context);
    if (isToolResult(prepared)) {
      return prepared;
    }
    if (this.hookOrchestrator.enabled) {
      return this.executeWithPermissionHooks(prepared);
    }
    const approval = this.approval.evaluate(prepared);
    if (isToolResult(approval)) {
      return approval;
    }
    if (approval?.action === "ask") {
      return this.runAfterApproval(prepared, approval, false);
    }
    return executeToolCall(
      prepared,
      withApprovedExternalPaths(prepared.context, approval?.approvedExternalPaths),
    );
  }

  waitForToolResult(
    request: RuntimeToolWaitRequest,
    context: RuntimeToolExecutionContext,
  ): RuntimeToolWaitResult | Promise<RuntimeToolWaitResult> {
    if (!this.taskTools) {
      return {
        success: false,
        timeout: false,
        payloads: [
          {
            task_id: request.backgroundTaskId,
            background_task_id: request.backgroundTaskId,
            status: "missing",
            success: false,
            summary: `后台任务 ${request.backgroundTaskId} 不存在`,
          },
        ],
      };
    }
    return this.taskTools.waitForBackgroundTask({
      taskId: request.backgroundTaskId,
      timeoutMs: request.timeoutMs,
      signal: context.signal,
    });
  }

  /** 启用 hook 时的编排:before/after_permission 钩子 → 审批判定 → ask 等待 或 带钩子执行。 */
  private async executeWithPermissionHooks(prepared: PreparedRuntimeTool): Promise<ToolExecutionResult> {
    const beforePermissionHook = await this.hookOrchestrator.runToolHook("tool.before_permission", {
      toolName: prepared.toolName,
      tool: toolToDefinition(prepared.tool),
      call: prepared.call,
      context: prepared.context,
    });
    if (beforePermissionHook.blockExecution || beforePermissionHook.permissionDecision === "deny") {
      return this.hookOrchestrator.hookBlockedResult(prepared.toolName, beforePermissionHook, "before_permission");
    }

    const approval = this.approval.evaluate(prepared, beforePermissionHook);
    if (isToolResult(approval)) {
      return approval;
    }
    const afterPermissionHook = await this.hookOrchestrator.runToolHook("tool.after_permission", {
      toolName: prepared.toolName,
      tool: toolToDefinition(prepared.tool),
      call: prepared.call,
      context: prepared.context,
      permissionDecision: approval ?? null,
    });
    if (afterPermissionHook.blockExecution || afterPermissionHook.permissionDecision === "deny") {
      return this.hookOrchestrator.hookBlockedResult(prepared.toolName, afterPermissionHook, "after_permission");
    }
    const finalApproval = applyHookPermissionDecision(
      approval,
      afterPermissionHook,
      prepared.toolName,
      prepared.toolPermission?.riskLevel ?? prepared.tool.riskLevel,
    );
    if (finalApproval?.action === "ask") {
      return this.runAfterApproval(prepared, finalApproval, true, {
        beforePermissionHook,
        afterPermissionHook,
      });
    }

    return this.hookOrchestrator.executeWithHooks(
      prepared,
      withApprovedExternalPaths(prepared.context, finalApproval?.approvedExternalPaths),
      { beforePermissionHook, afterPermissionHook },
    );
  }

  /** ask 决策:等待用户审批,批准后按是否带钩子执行,并把审批元数据并入结果。 */
  private async runAfterApproval(
    prepared: PreparedRuntimeTool,
    approvalDecision: RuntimeToolApprovalDecision,
    withHooks: boolean,
    hooks: { beforePermissionHook?: HookResult | undefined; afterPermissionHook?: HookResult | undefined } = {},
  ): Promise<ToolExecutionResult> {
    const resolution = await this.approval.waitForApproval(prepared, approvalDecision);
    if (!resolution.approved) {
      return resolution.result;
    }
    const contextWithPaths = withApprovedExternalPaths(prepared.context, approvalDecision.approvedExternalPaths);
    const result = withHooks
      ? await this.hookOrchestrator.executeWithHooks(prepared, contextWithPaths, hooks)
      : await executeToolCall(prepared, contextWithPaths);
    return withApprovalMetadata(result, approvalDecision, resolution.message);
  }
}
