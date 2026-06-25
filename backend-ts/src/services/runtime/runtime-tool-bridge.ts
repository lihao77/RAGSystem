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
import { withApprovalMetadata, withApprovedExternalPaths } from "./runtime-tool-bridge/arguments.js";
import {
  executeToolCall,
  isToolResult,
  ToolPreparer,
  type PreparedRuntimeTool,
} from "./runtime-tool-bridge/prepared.js";
import { ToolApprovalCoordinator, type ApprovalResolution } from "./runtime-tool-bridge/approval.js";
import { createToolRegistry, type RuntimeToolRegistry } from "../../tools/registry.js";

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
  vectorLibrary?: VectorLibraryService | null;
  mcp?: McpService | null;
  codeExecutionTools?: CodeExecutionToolService | null;
  skillTools?: SkillToolService | null;
}

/**
 * 工具桥——backend-ts 工具体系的门面。
 *
 * 职责收窄为两类：
 * 1. 持有工具注册表（toolRegistry），暴露给 SDK 适配层 + 监控/prompt-builder 查询可见工具。
 * 2. 为 CodeExecution 的工具互调（call_tool）提供 executeTool——走 prepare + 审批 + 执行。
 *
 * SDK 主路径（agent run）的工具编排已下沉到 SDK tool-round-executor，不再经过本桥。
 * hook 体系已移除（被 SDK 事件 hook 取代）。
 */
export class RuntimeToolBridge implements RuntimeToolExecutor {
  private agentDelegation: DelegationPort | null = null;
  /** 暴露内部注册表供 SDK ToolRegistry 适配层使用。 */
  readonly toolRegistry: RuntimeToolRegistry;
  private readonly preparer: ToolPreparer;
  private readonly approval: ToolApprovalCoordinator;
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
    const approval = this.approval.evaluate(prepared);
    if (isToolResult(approval)) {
      return approval;
    }
    if (approval?.action === "ask") {
      return this.runAfterApproval(prepared, approval);
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

  /** ask 决策：等待用户审批，批准后执行，并把审批元数据并入结果。 */
  private async runAfterApproval(
    prepared: PreparedRuntimeTool,
    approvalDecision: RuntimeToolApprovalDecision,
  ): Promise<ToolExecutionResult> {
    const resolution: ApprovalResolution = await this.approval.waitForApproval(prepared, approvalDecision);
    if (!resolution.approved) {
      return resolution.result;
    }
    const contextWithPaths = withApprovedExternalPaths(prepared.context, approvalDecision.approvedExternalPaths);
    const result = await executeToolCall(prepared, contextWithPaths);
    return withApprovalMetadata(result, approvalDecision, resolution.message);
  }
}
