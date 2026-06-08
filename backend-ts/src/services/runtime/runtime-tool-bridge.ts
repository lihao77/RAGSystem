import type { AgentConfig } from "../../contracts/agent-config.js";
import {
  type ToolExecutionResult,
  type MemoryToolService,
} from "../tools/memory-tool-service.js";
import type { LocalDocumentToolService } from "../tools/local-document-tool-service.js";
import type { CodeExecutionToolService } from "../tools/code-execution-tool-service.js";
import type { AgentDelegationService } from "../agent/agent-delegation-service.js";
import type { TaskToolService } from "../tools/task-tool-service.js";
import type { LocalSearchToolService } from "../tools/local-search-tool-service.js";
import type { SkillToolService } from "../tools/skill-tool-service.js";
import type { VectorLibraryService } from "../knowledge/vector-library-service.js";
import type { McpService } from "../integrations/mcp-service.js";
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
import type { HookRuntimeService, HookResult } from "./hooks/index.js";
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
  EXECUTE_CODE_TOOL,
  EXECUTE_CODE_TOOL_NAME,
  KNOWLEDGE_TOOLS,
  LOCAL_SEARCH_TOOLS,
  READ_ONLY_MEMORY_TOOLS,
  REQUEST_USER_INPUT_TOOL,
  REQUEST_USER_INPUT_TOOL_NAME,
  SKILL_TOOLS,
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
    private readonly hooks: HookRuntimeService | null = null,
    private readonly vectorLibrary: VectorLibraryService | null = null,
    private readonly mcp: McpService | null = null,
    private readonly codeExecutionTools: CodeExecutionToolService | null = null,
    private readonly skillTools: SkillToolService | null = null,
  ) {
    this.toolHandlers = createRuntimeToolHandlers({
      memoryTools,
      documentTools,
      codeExecutionTools,
      skillTools,
      searchTools,
      taskTools,
      vectorLibrary,
      mcp,
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
    if (this.codeExecutionTools && enabledTools.has(EXECUTE_CODE_TOOL_NAME)) {
      tools.push({ ...EXECUTE_CODE_TOOL });
    }
    if (this.skillTools && agent?.skills.auto_inject && this.skillTools.hasVisibleSkills(agent)) {
      tools.push(...SKILL_TOOLS.map((tool) => ({ ...tool })));
    }
    if (this.searchTools) {
      for (const tool of LOCAL_SEARCH_TOOLS) {
        if (enabledTools.has(tool.name)) {
          tools.push({ ...tool });
        }
      }
    }
    if (this.vectorLibrary && agent?.knowledge_base.enabled) {
      tools.push(...KNOWLEDGE_TOOLS.map((tool) => ({ ...tool })));
    }
    if (this.taskTools) {
      if (agent?.tasks?.workflow) {
        tools.push(...TASK_WORKFLOW_TOOLS.map((tool) => ({ ...tool })));
      }
      if (agent?.tasks?.background || enabledTools.has(TASK_OUTPUT_TOOL_NAME)) {
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
    if (this.mcp && agent?.mcp.enabled_servers.length) {
      tools.push(...this.mcp.listRuntimeTools(agent.mcp.enabled_servers));
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
    if (this.hooks) {
      return this.executeToolWithHooks(call, context);
    }
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

  private async executeToolWithHooks(call: RuntimeToolCall, context: RuntimeToolExecutionContext): Promise<ToolExecutionResult> {
    const executionContext = buildToolCallContext(call, context);
    const toolName = call.toolName.trim();
    const tool = this.getVisibleTool(toolName, executionContext.agent);
    if (!tool) {
      return errorResult(`工具未暴露或暂未迁移: ${toolName}`, toolName || "unknown");
    }

    const beforePermissionHook = await this.runToolHook("tool.before_permission", {
      toolName,
      tool,
      call,
      context: executionContext,
    });
    if (beforePermissionHook.blockExecution || beforePermissionHook.permissionDecision === "deny") {
      return this.hookBlockedResult(toolName, beforePermissionHook, "before_permission");
    }

    if (toolName === EXECUTE_BASH_TOOL_NAME && this.bashTools) {
      return this.executeBashToolWithHooks(call, executionContext, beforePermissionHook);
    }

    const approvedExternalPaths = this.collectExternalPathApprovalCandidates(toolName, call.arguments, executionContext);
    const approvalDecision = this.applyHookPermissionDecision(this.permissionPolicy?.evaluateToolApproval({
      toolName,
      riskLevel: tool.riskLevel,
      description: tool.description,
      arguments: call.arguments ?? {},
      sessionId: executionContext.sessionId,
      approvalExempt: tool.approvalExempt,
      approvedExternalPaths,
    }), beforePermissionHook, toolName, tool.riskLevel);
    const afterPermissionHook = await this.runToolHook("tool.after_permission", {
      toolName,
      tool,
      call,
      context: executionContext,
      permissionDecision: approvalDecision ?? null,
    });
    if (afterPermissionHook.blockExecution || afterPermissionHook.permissionDecision === "deny") {
      return this.hookBlockedResult(toolName, afterPermissionHook, "after_permission");
    }
    const finalApprovalDecision = this.applyHookPermissionDecision(
      approvalDecision,
      afterPermissionHook,
      toolName,
      tool.riskLevel,
    );
    if (finalApprovalDecision?.action === "ask") {
      return this.executeToolAfterApproval(call, executionContext, finalApprovalDecision);
    }
    if (!approvalDecision && approvedExternalPaths.length) {
      return approvalUnsupportedError(toolName, approvedExternalPaths);
    }

    return this.executeAllowedToolWithHooks(
      toolName,
      call,
      withApprovedExternalPaths(executionContext, finalApprovalDecision?.approvedExternalPaths),
      { beforePermissionHook, afterPermissionHook },
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
    if (handler) {
      return handler(call, context);
    }
    if (this.mcp && toolName.startsWith("mcp__")) {
      return this.mcp.callRuntimeTool(toolName, call.arguments);
    }
    return this.unavailableTool(toolName);
  }

  private async executeAllowedToolWithHooks(
    toolName: string,
    call: RuntimeToolCall,
    context: RuntimeToolExecutionContext,
    hooks: { beforePermissionHook?: HookResult | undefined; afterPermissionHook?: HookResult | undefined } = {},
  ): Promise<ToolExecutionResult> {
    const tool = this.getVisibleTool(toolName, context.agent);
    const beforeExecuteHook = await this.runToolHook("tool.before_execute", {
      toolName,
      tool,
      call,
      context,
    });
    if (beforeExecuteHook.blockExecution || beforeExecuteHook.permissionDecision === "deny") {
      return this.hookBlockedResult(toolName, beforeExecuteHook, "before_execute");
    }
    try {
      let result = await this.executeAllowedTool(toolName, call, context);
      result = this.mergeHookData(result, hooks.beforePermissionHook, "before_permission");
      result = this.mergeHookData(result, hooks.afterPermissionHook, "after_permission");
      result = this.mergeHookData(result, beforeExecuteHook, "before_execute");
      const afterExecuteHook = await this.runToolHook("tool.after_execute", {
        toolName,
        tool,
        call,
        context,
        result,
      });
      result = this.mergeHookData(result, afterExecuteHook, "after_execute");
      return result;
    } catch (error) {
      const onErrorHook = await this.runToolHook("tool.on_error", {
        toolName,
        tool,
        call,
        context,
        error,
      });
      if (onErrorHook.blockExecution) {
        return this.hookBlockedResult(toolName, onErrorHook, "on_error");
      }
      const result = errorResult(`工具执行异常: ${error instanceof Error ? error.message : String(error)}`, toolName);
      return this.mergeHookData(result, onErrorHook, "on_error");
    }
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

  private async executeBashToolWithHooks(
    call: RuntimeToolCall,
    context: RuntimeToolExecutionContext,
    beforePermissionHook: HookResult,
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
    const approvalDecision = this.applyHookPermissionDecision(this.permissionPolicy?.evaluateToolApproval({
      toolName: EXECUTE_BASH_TOOL_NAME,
      riskLevel: plan.riskLevel,
      description: plan.approvalDescription,
      arguments: plan.approvalArguments,
      sessionId: context.sessionId,
      forceAsk: plan.approvalRequired,
      approvedExternalPaths,
    }), beforePermissionHook, EXECUTE_BASH_TOOL_NAME, plan.riskLevel);
    const afterPermissionHook = await this.runToolHook("tool.after_permission", {
      toolName: EXECUTE_BASH_TOOL_NAME,
      tool: {
        riskLevel: plan.riskLevel,
        source: "execution",
      },
      call,
      context,
      permissionDecision: approvalDecision ?? null,
    });
    if (afterPermissionHook.blockExecution || afterPermissionHook.permissionDecision === "deny") {
      return this.hookBlockedResult(EXECUTE_BASH_TOOL_NAME, afterPermissionHook, "after_permission");
    }
    const finalApprovalDecision = this.applyHookPermissionDecision(
      approvalDecision,
      afterPermissionHook,
      EXECUTE_BASH_TOOL_NAME,
      plan.riskLevel,
    );

    if (finalApprovalDecision?.action === "ask") {
      return this.executeBashAfterApproval(plan, call, context, finalApprovalDecision);
    }
    if (!finalApprovalDecision && plan.approvalRequired) {
      return errorResult(`工具 ${EXECUTE_BASH_TOOL_NAME} 需要用户授权，但当前上下文不支持审批`, EXECUTE_BASH_TOOL_NAME, {
        ...plan.metadata,
      });
    }

    return this.executeBashPlanWithHooks(
      plan,
      call,
      withApprovedExternalPaths(context, finalApprovalDecision?.approvedExternalPaths),
      { beforePermissionHook, afterPermissionHook },
    );
  }

  private async executeBashPlanWithHooks(
    plan: BashExecutionPlan,
    call: RuntimeToolCall,
    context: RuntimeToolExecutionContext,
    hooks: { beforePermissionHook?: HookResult | undefined; afterPermissionHook?: HookResult | undefined } = {},
  ): Promise<ToolExecutionResult> {
    const bashTools = this.bashTools;
    if (!bashTools) {
      return errorResult(`工具未暴露或暂未迁移: ${EXECUTE_BASH_TOOL_NAME}`, EXECUTE_BASH_TOOL_NAME);
    }
    const tool = {
      riskLevel: plan.riskLevel,
      source: "execution" as const,
    };
    const beforeExecuteHook = await this.runToolHook("tool.before_execute", {
      toolName: EXECUTE_BASH_TOOL_NAME,
      tool,
      call,
      context,
    });
    if (beforeExecuteHook.blockExecution || beforeExecuteHook.permissionDecision === "deny") {
      return this.hookBlockedResult(EXECUTE_BASH_TOOL_NAME, beforeExecuteHook, "before_execute");
    }
    let result = await bashTools.executePlan(plan, context);
    result = this.mergeHookData(result, hooks.beforePermissionHook, "before_permission");
    result = this.mergeHookData(result, hooks.afterPermissionHook, "after_permission");
    result = this.mergeHookData(result, beforeExecuteHook, "before_execute");
    const afterExecuteHook = await this.runToolHook("tool.after_execute", {
      toolName: EXECUTE_BASH_TOOL_NAME,
      tool,
      call,
      context,
      result,
    });
    return this.mergeHookData(result, afterExecuteHook, "after_execute");
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

    const result = await this.executeBashPlanWithHooks(plan, call, withApprovedExternalPaths(context, approvalDecision.approvedExternalPaths));
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

    const result = await this.executeAllowedToolWithHooks(toolName, call, withApprovedExternalPaths(context, approvalDecision.approvedExternalPaths));
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

  private async runToolHook(
    eventName: "tool.before_permission" | "tool.after_permission" | "tool.before_execute" | "tool.after_execute" | "tool.on_error",
    input: Parameters<HookRuntimeService["runToolHook"]>[1],
  ): Promise<HookResult> {
    return this.hooks ? this.hooks.runToolHook(eventName, input) : {
      continueExecution: true,
      blockExecution: false,
      blockReason: "",
    };
  }

  private mergeHookData<T>(
    result: ToolExecutionResult<T>,
    hookResult: HookResult | undefined,
    phase: "before_permission" | "after_permission" | "before_execute" | "after_execute" | "on_error",
  ): ToolExecutionResult<T> {
    return hookResult && this.hooks ? this.hooks.mergeHookData(result, hookResult, phase) : result;
  }

  private hookBlockedResult(
    toolName: string,
    hookResult: HookResult,
    phase: "before_permission" | "after_permission" | "before_execute" | "after_execute" | "on_error",
  ): ToolExecutionResult<string> {
    const result = errorResult(hookResult.blockReason || "Hook blocked tool execution", toolName, {
      hook_blocked: true,
      hook_phase: phase,
      ...(hookResult.permissionDecision ? { hook_permission_decision: hookResult.permissionDecision } : {}),
    });
    return this.mergeHookData(result, hookResult, phase);
  }

  private applyHookPermissionDecision(
    decision: RuntimeToolApprovalDecision | undefined,
    hookResult: HookResult,
    toolName: string,
    riskLevel: RuntimeToolApprovalDecision["riskLevel"] | undefined,
  ): RuntimeToolApprovalDecision | undefined {
    if (!hookResult.permissionDecision) {
      return decision;
    }
    if (hookResult.permissionDecision === "allow") {
      return {
        ...(decision ?? buildHookApprovalDecision(toolName, riskLevel)),
        action: "allow",
        reason: "hook permission decision: allow",
      };
    }
    if (hookResult.permissionDecision === "ask") {
      return {
        ...(decision ?? buildHookApprovalDecision(toolName, riskLevel)),
        action: "ask",
        reason: hookResult.uiMessage ?? "hook permission decision: ask",
        reasonCodes: [...(decision?.reasonCodes ?? []), "ask-hook"],
      };
    }
    return decision;
  }
}

function buildHookApprovalDecision(
  toolName: string,
  riskLevel: RuntimeToolApprovalDecision["riskLevel"] | undefined,
): RuntimeToolApprovalDecision {
  return {
    action: "allow",
    toolName,
    riskLevel: riskLevel ?? "low",
    description: `Tool ${toolName}`,
    permissionMode: "standard",
    reason: "hook permission decision",
    reasonCodes: [],
    secondaryReasons: [],
    approvedExternalPaths: [],
  };
}
