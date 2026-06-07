import type { AgentConfig } from "../../contracts/agent-config.js";
import {
  type ToolExecutionResult,
  type MemoryToolService,
} from "../tools/memory-tool-service.js";
import type { LocalDocumentToolService } from "../tools/local-document-tool-service.js";
import type { AgentDelegationService } from "../agent/agent-delegation-service.js";
import type { TaskToolService } from "../tools/task-tool-service.js";
import type { LocalSearchToolService } from "../tools/local-search-tool-service.js";
import type {
  BashExecutionPlan,
  LocalBashToolService,
} from "../tools/local-bash-tool-service.js";
import type {
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolExecutionContext,
  RuntimeToolExecutor,
  RuntimeToolWaitRequest,
  RuntimeToolWaitResult,
} from "./runtime-tool-types.js";
import type { PendingInteractionService } from "./pending-interaction-service.js";
import type {
  PermissionPolicyService,
  RuntimeToolApprovalDecision,
} from "./permission-policy-service.js";
import {
  approvalUnsupportedError,
  buildApprovalMetadata,
  buildToolCallContext,
  dedupeStrings,
  errorResult,
  readBashArguments,
  readInputType,
  readOptions,
  readPrompt,
  successResult,
  withApprovalMetadata,
  withApprovedExternalPaths,
} from "./runtime-tool-bridge/arguments.js";
export { isReadOnlyMemoryToolName } from "./runtime-tool-bridge/arguments.js";
import { createRuntimeToolHandlers, type RuntimeToolHandler } from "./runtime-tool-bridge/handlers.js";
import {
  AGENT_DELEGATION_TOOLS,
  ARCHIVE_MEMORY_TOOL,
  DOCUMENT_TOOLS,
  EXECUTE_BASH_TOOL,
  EXECUTE_BASH_TOOL_NAME,
  LOCAL_SEARCH_TOOLS,
  READ_ONLY_MEMORY_TOOLS,
  REQUEST_USER_INPUT_TOOL,
  REQUEST_USER_INPUT_TOOL_NAME,
  TASK_OUTPUT_TOOL,
  TASK_OUTPUT_TOOL_NAME,
  TASK_STOP_TOOL,
  TASK_WORKFLOW_TOOLS,
  WRITE_MEMORY_TOOL,
} from "./runtime-tool-bridge/registry.js";

export class RuntimeToolBridge implements RuntimeToolExecutor {
  private agentDelegation: AgentDelegationService | null = null;
  private readonly toolHandlers: Map<string, RuntimeToolHandler>;

  constructor(
    private readonly memoryTools: MemoryToolService,
    private readonly pendingInteractions: PendingInteractionService | null = null,
    private readonly permissionPolicy: PermissionPolicyService | null = null,
    private readonly documentTools: LocalDocumentToolService | null = null,
    private readonly bashTools: LocalBashToolService | null = null,
    private readonly taskTools: TaskToolService | null = null,
    private readonly searchTools: LocalSearchToolService | null = null,
  ) {
    this.toolHandlers = createRuntimeToolHandlers({
      memoryTools,
      documentTools,
      searchTools,
      taskTools,
      getAgentDelegation: () => this.agentDelegation,
      requestUserInput: (call, context) => this.requestUserInput(call, context),
      unavailableTool: (toolName) => this.unavailableTool(toolName),
    });
  }

  setAgentDelegation(agentDelegation: AgentDelegationService | null): void {
    this.agentDelegation = agentDelegation;
  }

  listVisibleTools(agent: AgentConfig | null): RuntimeToolDefinition[] {
    const tools: RuntimeToolDefinition[] = [];
    const enabledTools = new Set(agent?.tools.enabled_tools ?? []);
    if (this.pendingInteractions) {
      tools.push({ ...REQUEST_USER_INPUT_TOOL });
    }
    if (this.documentTools) {
      for (const tool of DOCUMENT_TOOLS) {
        if (enabledTools.has(tool.name)) {
          tools.push({ ...tool });
        }
      }
    }
    if (this.bashTools && enabledTools.has(EXECUTE_BASH_TOOL_NAME)) {
      tools.push({ ...EXECUTE_BASH_TOOL });
    }
    if (this.searchTools) {
      for (const tool of LOCAL_SEARCH_TOOLS) {
        if (enabledTools.has(tool.name)) {
          tools.push({ ...tool });
        }
      }
    }
    if (this.taskTools) {
      if (agent?.tasks?.workflow) {
        tools.push(...TASK_WORKFLOW_TOOLS.map((tool) => ({ ...tool })));
      }
      if (enabledTools.has(TASK_OUTPUT_TOOL_NAME)) {
        tools.push({ ...TASK_OUTPUT_TOOL });
      }
      if (agent?.tasks?.background) {
        tools.push({ ...TASK_STOP_TOOL });
      }
    }
    const memoryConfig = agent?.memory;
    if (memoryConfig?.allowed_scopes?.length) {
      tools.push(...READ_ONLY_MEMORY_TOOLS.map((tool) => ({ ...tool })));
    }
    if (memoryConfig?.write_scopes?.length) {
      tools.push({ ...WRITE_MEMORY_TOOL });
    }
    if (memoryConfig?.archive_scopes?.length) {
      tools.push({ ...ARCHIVE_MEMORY_TOOL });
    }
    if (this.agentDelegation && agent?.delegation.enabled_agents?.length) {
      tools.push(...AGENT_DELEGATION_TOOLS.map((tool) => ({ ...tool })));
    }
    return tools;
  }

  listVisibleToolNames(agent: AgentConfig | null): string[] {
    return this.listVisibleTools(agent).map((tool) => tool.name);
  }

  canExecuteTool(toolName: string, agent: AgentConfig | null): boolean {
    return this.listVisibleToolNames(agent).includes(toolName);
  }

  executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext): ToolExecutionResult | Promise<ToolExecutionResult> {
    const executionContext = buildToolCallContext(call, context);
    const toolName = call.toolName.trim();
    const tool = this.getVisibleTool(toolName, executionContext.agent);
    if (!tool) {
      return errorResult(`工具未暴露或暂未迁移: ${toolName}`, toolName || "unknown");
    }

    if (toolName === EXECUTE_BASH_TOOL_NAME && this.bashTools) {
      return this.executeBashTool(call, executionContext);
    }

    const approvedExternalPaths = this.collectExternalPathApprovalCandidates(toolName, call.arguments, executionContext);
    const approvalDecision = this.permissionPolicy?.evaluateToolApproval({
      toolName,
      riskLevel: tool.riskLevel,
      description: tool.description,
      arguments: call.arguments ?? {},
      sessionId: executionContext.sessionId,
      approvalExempt: tool.approvalExempt,
      approvedExternalPaths,
    });
    if (approvalDecision?.action === "ask") {
      return this.executeToolAfterApproval(call, executionContext, approvalDecision);
    }
    if (!approvalDecision && approvedExternalPaths.length) {
      return approvalUnsupportedError(toolName, approvedExternalPaths);
    }

    return this.executeAllowedTool(
      toolName,
      call,
      withApprovedExternalPaths(executionContext, approvalDecision?.approvedExternalPaths),
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

  private getVisibleTool(toolName: string, agent: AgentConfig | null): RuntimeToolDefinition | null {
    return this.listVisibleTools(agent).find((tool) => tool.name === toolName) ?? null;
  }

  private executeAllowedTool(
    toolName: string,
    call: RuntimeToolCall,
    context: RuntimeToolExecutionContext,
  ): ToolExecutionResult | Promise<ToolExecutionResult> {
    const handler = this.toolHandlers.get(toolName);
    return handler ? handler(call, context) : this.unavailableTool(toolName);
  }

  private unavailableTool(toolName: string): ToolExecutionResult<string> {
    return errorResult(`工具未暴露或暂未迁移: ${toolName}`, toolName);
  }

  private collectExternalPathApprovalCandidates(
    toolName: string,
    args: Record<string, unknown> | undefined,
    context: RuntimeToolExecutionContext,
  ): string[] {
    const documentCandidates = this.documentTools?.getExternalPathApprovalCandidates(toolName, args, context) ?? [];
    return dedupeStrings(documentCandidates);
  }

  private async executeBashTool(
    call: RuntimeToolCall,
    context: RuntimeToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (!this.bashTools) {
      return errorResult(`工具未暴露或暂未迁移: ${EXECUTE_BASH_TOOL_NAME}`, EXECUTE_BASH_TOOL_NAME);
    }
    const bashInput = readBashArguments(call.arguments);
    const approvedExternalPaths = this.bashTools.getExternalPathApprovalCandidates(bashInput, context);
    if (!this.permissionPolicy && approvedExternalPaths.length) {
      return approvalUnsupportedError(EXECUTE_BASH_TOOL_NAME, approvedExternalPaths);
    }
    const planningContext = withApprovedExternalPaths(context, approvedExternalPaths);
    const prepared = this.bashTools.prepareExecution(bashInput, planningContext);
    if (!prepared.ok) {
      return prepared.result;
    }

    const plan = prepared.plan;
    const approvalDecision = this.permissionPolicy?.evaluateToolApproval({
      toolName: EXECUTE_BASH_TOOL_NAME,
      riskLevel: plan.riskLevel,
      description: plan.approvalDescription,
      arguments: plan.approvalArguments,
      sessionId: context.sessionId,
      forceAsk: plan.approvalRequired,
      approvedExternalPaths,
    });

    if (approvalDecision?.action === "ask") {
      return this.executeBashAfterApproval(plan, call, context, approvalDecision);
    }
    if (!approvalDecision && plan.approvalRequired) {
      return errorResult(`工具 ${EXECUTE_BASH_TOOL_NAME} 需要用户授权，但当前上下文不支持审批`, EXECUTE_BASH_TOOL_NAME, {
        ...plan.metadata,
      });
    }

    return this.bashTools.executePlan(plan, withApprovedExternalPaths(context, approvalDecision?.approvedExternalPaths));
  }

  private async executeBashAfterApproval(
    plan: BashExecutionPlan,
    call: RuntimeToolCall,
    context: RuntimeToolExecutionContext,
    approvalDecision: RuntimeToolApprovalDecision,
  ): Promise<ToolExecutionResult> {
    const bashTools = this.bashTools;
    if (!bashTools) {
      return errorResult(`工具未暴露或暂未迁移: ${EXECUTE_BASH_TOOL_NAME}`, EXECUTE_BASH_TOOL_NAME);
    }
    const approvalMetadata = buildApprovalMetadata(approvalDecision);
    if (!this.pendingInteractions) {
      return errorResult(`工具 ${EXECUTE_BASH_TOOL_NAME} 需要用户授权，但当前上下文不支持审批`, EXECUTE_BASH_TOOL_NAME, {
        ...plan.metadata,
        approval: approvalMetadata,
      });
    }

    const sessionId = context.sessionId?.trim();
    if (!sessionId) {
      return errorResult(`工具 ${EXECUTE_BASH_TOOL_NAME} 需要用户授权，但当前上下文无法等待审批`, EXECUTE_BASH_TOOL_NAME, {
        ...plan.metadata,
        approval: approvalMetadata,
      });
    }

    let resolution;
    try {
      resolution = await this.pendingInteractions.waitForApproval({
        sessionId,
        runId: context.runId,
        taskId: context.taskId,
        requestId: context.requestId,
        toolCallId: context.toolCallId ?? call.callId ?? null,
        agentName: context.currentAgentName ?? context.agent?.agent_name ?? null,
        approvalType: "bash_command",
        toolName: EXECUTE_BASH_TOOL_NAME,
        arguments: plan.approvalArguments,
        riskLevel: approvalDecision.riskLevel,
        description: approvalDecision.description,
        permissionMode: approvalDecision.permissionMode,
        approvalReason: approvalDecision.reason,
        approvalReasonCodes: approvalDecision.reasonCodes,
        approvalSecondaryReasons: approvalDecision.secondaryReasons,
        approvedExternalPaths: approvalDecision.approvedExternalPaths,
        signal: context.signal,
      });
    } catch (error) {
      return errorResult(`审批流程异常: ${error instanceof Error ? error.message : String(error)}`, EXECUTE_BASH_TOOL_NAME, {
        ...plan.metadata,
        approval: approvalMetadata,
      });
    }

    if (!resolution.approved) {
      const denyReason = resolution.message || "用户拒绝执行此操作";
      return errorResult(`execute_bash 执行已被拒绝：${denyReason}`, EXECUTE_BASH_TOOL_NAME, {
        ...plan.metadata,
        approval: buildApprovalMetadata(approvalDecision, resolution.message),
      });
    }

    const result = await bashTools.executePlan(plan, withApprovedExternalPaths(context, approvalDecision.approvedExternalPaths));
    return withApprovalMetadata(result, approvalDecision, resolution.message);
  }

  private async executeToolAfterApproval(
    call: RuntimeToolCall,
    context: RuntimeToolExecutionContext,
    approvalDecision: RuntimeToolApprovalDecision,
  ): Promise<ToolExecutionResult> {
    const toolName = approvalDecision.toolName;
    const approvalMetadata = buildApprovalMetadata(approvalDecision);
    if (!this.pendingInteractions) {
      return errorResult(`工具 ${toolName} 需要用户授权，但当前上下文不支持审批`, toolName, {
        approval: approvalMetadata,
      });
    }

    const sessionId = context.sessionId?.trim();
    if (!sessionId) {
      return errorResult(`工具 ${toolName} 需要用户授权，但当前上下文无法等待审批`, toolName, {
        approval: approvalMetadata,
      });
    }

    let resolution;
    try {
      resolution = await this.pendingInteractions.waitForApproval({
        sessionId,
        runId: context.runId,
        taskId: context.taskId,
        requestId: context.requestId,
        toolCallId: context.toolCallId ?? call.callId ?? null,
        agentName: context.currentAgentName ?? context.agent?.agent_name ?? null,
        approvalType: "tool_execution",
        toolName,
        arguments: call.arguments ?? {},
        riskLevel: approvalDecision.riskLevel,
        description: approvalDecision.description,
        permissionMode: approvalDecision.permissionMode,
        approvalReason: approvalDecision.reason,
        approvalReasonCodes: approvalDecision.reasonCodes,
        approvalSecondaryReasons: approvalDecision.secondaryReasons,
        approvedExternalPaths: approvalDecision.approvedExternalPaths,
        signal: context.signal,
      });
    } catch (error) {
      return errorResult(`审批流程异常: ${error instanceof Error ? error.message : String(error)}`, toolName, {
        approval: approvalMetadata,
      });
    }

    if (!resolution.approved) {
      const denyReason = resolution.message || "用户拒绝执行此操作";
      return errorResult(`工具 ${toolName} 执行已被拒绝：${denyReason}`, toolName, {
        approval: buildApprovalMetadata(approvalDecision, resolution.message),
      });
    }

    const result = await this.executeAllowedTool(toolName, call, withApprovedExternalPaths(context, approvalDecision.approvedExternalPaths));
    return withApprovalMetadata(result, approvalDecision, resolution.message);
  }

  private async requestUserInput(
    call: RuntimeToolCall,
    context: RuntimeToolExecutionContext,
  ): Promise<ToolExecutionResult<string>> {
    if (!this.pendingInteractions) {
      return errorResult("request_user_input 暂不可用", REQUEST_USER_INPUT_TOOL_NAME);
    }
    const prompt = readPrompt(call.arguments);
    if (!prompt) {
      return errorResult("request_user_input 缺少 prompt", REQUEST_USER_INPUT_TOOL_NAME);
    }
    if (!context.sessionId) {
      return successResult("", {
        summary: "当前上下文缺少 session_id，未等待用户输入",
        outputType: "text",
        metadata: {
          input_type: readInputType(call.arguments),
          options: readOptions(call.arguments),
          degraded: true,
        },
        toolName: REQUEST_USER_INPUT_TOOL_NAME,
      });
    }

    const startedAt = Date.now();
    const resolution = await this.pendingInteractions.waitForUserInput({
      sessionId: context.sessionId,
      runId: context.runId,
      taskId: context.taskId,
      requestId: context.requestId,
      toolCallId: context.toolCallId ?? call.callId ?? null,
      agentName: context.currentAgentName ?? context.agent?.agent_name ?? null,
      prompt,
      inputType: readInputType(call.arguments),
      options: readOptions(call.arguments),
      signal: context.signal,
    });

    return successResult(resolution.value, {
      summary: "用户输入已接收",
      outputType: "text",
      metadata: {
        input_id: resolution.inputId,
        input_type: readInputType(call.arguments),
        options: readOptions(call.arguments),
        degraded: false,
        waited_seconds: (Date.now() - startedAt) / 1000,
      },
      toolName: REQUEST_USER_INPUT_TOOL_NAME,
    });
  }
}
