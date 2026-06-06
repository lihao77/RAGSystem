import type { AgentConfig } from "../contracts/agent-config.js";
import {
  type ToolExecutionResult,
  type MemoryToolService,
} from "./memory-tool-service.js";
import type { LocalDocumentToolService } from "./local-document-tool-service.js";
import type { AgentDelegationService } from "./agent-delegation-service.js";
import type { TaskToolService } from "./task-tool-service.js";
import type {
  BashExecutionInput,
  BashExecutionPlan,
  LocalBashToolService,
} from "./local-bash-tool-service.js";
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
  AGENT_DELEGATION_TOOLS,
  ARCHIVE_MEMORY_TOOL,
  ARCHIVE_MEMORY_TOOL_NAME,
  CALL_AGENT_TOOL_NAME,
  DOCUMENT_TOOLS,
  EDIT_FILE_TOOL_NAME,
  EXECUTE_BASH_TOOL,
  EXECUTE_BASH_TOOL_NAME,
  LIST_CHILD_AGENTS_TOOL_NAME,
  PREVIEW_DATA_STRUCTURE_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  READ_ONLY_MEMORY_TOOL_NAMES,
  READ_ONLY_MEMORY_TOOLS,
  REQUEST_USER_INPUT_TOOL,
  REQUEST_USER_INPUT_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_OUTPUT_TOOL,
  TASK_OUTPUT_TOOL_NAME,
  TASK_STOP_TOOL,
  TASK_STOP_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TASK_WORKFLOW_TOOLS,
  WRITE_FILE_TOOL_NAME,
  WRITE_MEMORY_TOOL,
  WRITE_MEMORY_TOOL_NAME,
  type ReadOnlyMemoryToolName,
} from "./runtime-tool-bridge/registry.js";

export class RuntimeToolBridge implements RuntimeToolExecutor {
  private agentDelegation: AgentDelegationService | null = null;

  constructor(
    private readonly memoryTools: MemoryToolService,
    private readonly pendingInteractions: PendingInteractionService | null = null,
    private readonly permissionPolicy: PermissionPolicyService | null = null,
    private readonly documentTools: LocalDocumentToolService | null = null,
    private readonly bashTools: LocalBashToolService | null = null,
    private readonly taskTools: TaskToolService | null = null,
  ) {}

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
    if (toolName === REQUEST_USER_INPUT_TOOL_NAME) {
      return this.requestUserInput(call, context);
    }
    if (toolName === READ_FILE_TOOL_NAME && this.documentTools) {
      return this.documentTools.readFile(readFileArguments(call.arguments), context);
    }
    if (toolName === WRITE_FILE_TOOL_NAME && this.documentTools) {
      return this.documentTools.writeFile(writeFileArguments(call.arguments), context);
    }
    if (toolName === EDIT_FILE_TOOL_NAME && this.documentTools) {
      return this.documentTools.editFile(editFileArguments(call.arguments), context);
    }
    if (toolName === PREVIEW_DATA_STRUCTURE_TOOL_NAME && this.documentTools) {
      return this.documentTools.previewDataStructure(previewDataStructureArguments(call.arguments), context);
    }
    if (toolName === TASK_CREATE_TOOL_NAME && this.taskTools) {
      return this.taskTools.taskCreate(readTaskCreateArguments(call.arguments), context);
    }
    if (toolName === TASK_GET_TOOL_NAME && this.taskTools) {
      return this.taskTools.taskGet(readTaskGetArguments(call.arguments), context);
    }
    if (toolName === TASK_UPDATE_TOOL_NAME && this.taskTools) {
      return this.taskTools.taskUpdate(readTaskUpdateArguments(call.arguments), context);
    }
    if (toolName === TASK_LIST_TOOL_NAME && this.taskTools) {
      return this.taskTools.taskList(context);
    }
    if (toolName === TASK_OUTPUT_TOOL_NAME && this.taskTools) {
      return this.taskTools.taskOutput(readTaskOutputArguments(call.arguments));
    }
    if (toolName === TASK_STOP_TOOL_NAME && this.taskTools) {
      return this.taskTools.taskStop(readTaskStopArguments(call.arguments));
    }
    if (toolName === "list_memory_index") {
      return this.memoryTools.listMemoryIndex(readListMemoryIndexArguments(call.arguments), context);
    }
    if (toolName === "read_memory_entry") {
      return this.memoryTools.readMemoryEntry(readMemoryEntryArguments(call.arguments), context);
    }
    if (toolName === WRITE_MEMORY_TOOL_NAME) {
      return this.memoryTools.writeMemory(readWriteMemoryArguments(call.arguments), context);
    }
    if (toolName === ARCHIVE_MEMORY_TOOL_NAME) {
      return this.memoryTools.archiveMemory(readArchiveMemoryArguments(call.arguments), context);
    }
    if (toolName === CALL_AGENT_TOOL_NAME && this.agentDelegation) {
      return this.agentDelegation.callAgent(readCallAgentArguments(call.arguments, context.toolCallId ?? call.callId), context);
    }
    if (toolName === LIST_CHILD_AGENTS_TOOL_NAME && this.agentDelegation) {
      return this.agentDelegation.listChildAgents(readListChildAgentsArguments(call.arguments), context);
    }
    if (toolName === SEND_MESSAGE_TOOL_NAME && this.agentDelegation) {
      return this.agentDelegation.sendMessage(readSendMessageArguments(call.arguments, context.toolCallId ?? call.callId), context);
    }
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

function buildToolCallContext(
  call: RuntimeToolCall,
  context: RuntimeToolExecutionContext,
): RuntimeToolExecutionContext {
  const callId = context.toolCallId ?? call.callId ?? null;
  if (callId === context.toolCallId) {
    return context;
  }
  return {
    ...context,
    toolCallId: callId,
  };
}

function readTaskCreateArguments(value: Record<string, unknown> | undefined): {
  subject: string;
  description: string;
  activeForm?: string | null;
  metadata?: Record<string, unknown> | null;
} {
  return {
    subject: asString(value?.subject) ?? "",
    description: asString(value?.description) ?? "",
    activeForm: asString(value?.active_form) ?? asString(value?.activeForm),
    metadata: asRecord(value?.metadata),
  };
}

function readTaskGetArguments(value: Record<string, unknown> | undefined): { taskId: string } {
  return {
    taskId: asString(value?.task_id) ?? asString(value?.taskId) ?? "",
  };
}

function readTaskUpdateArguments(value: Record<string, unknown> | undefined): {
  taskId: string;
  subject?: string | null;
  description?: string | null;
  activeForm?: string | null;
  owner?: string | null;
  status?: string | null;
  addBlocks?: string[] | null;
  addBlockedBy?: string[] | null;
  metadata?: Record<string, unknown> | null;
} {
  const subject = asProvidedString(value, "subject");
  const description = asProvidedString(value, "description");
  const activeForm = asProvidedString(value, "active_form", "activeForm");
  const owner = asProvidedString(value, "owner");
  return {
    taskId: asString(value?.task_id) ?? asString(value?.taskId) ?? "",
    status: asString(value?.status),
    addBlocks: asStringArray(value?.add_blocks) ?? asStringArray(value?.addBlocks),
    addBlockedBy: asStringArray(value?.add_blocked_by) ?? asStringArray(value?.addBlockedBy),
    metadata: asRecord(value?.metadata),
    ...(subject !== undefined ? { subject } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(activeForm !== undefined ? { activeForm } : {}),
    ...(owner !== undefined ? { owner } : {}),
  };
}

function readTaskOutputArguments(value: Record<string, unknown> | undefined): {
  taskId: string;
  block?: boolean | null;
  timeout?: number | null;
  maxChars?: number | null;
} {
  return {
    taskId: asString(value?.task_id) ?? asString(value?.taskId) ?? "",
    block: typeof value?.block === "boolean" ? value.block : null,
    timeout: asInteger(value?.timeout),
    maxChars: asInteger(value?.max_chars) ?? asInteger(value?.maxChars),
  };
}

function readTaskStopArguments(value: Record<string, unknown> | undefined): { taskId: string } {
  return {
    taskId: asString(value?.task_id) ?? asString(value?.taskId) ?? "",
  };
}

function readListMemoryIndexArguments(value: Record<string, unknown> | undefined): {
  scope: string;
  sessionId?: string | null;
  agentName?: string | null;
  workspaceKey?: string | null;
  currentAgentName?: string | null;
  teamName?: string | null;
  workspaceRoot?: string | null;
} {
  return {
    scope: asString(value?.scope) ?? "",
    sessionId: asString(value?.session_id) ?? asString(value?.sessionId),
    agentName: asString(value?.agent_name) ?? asString(value?.agentName),
    workspaceKey: asString(value?.workspace_key) ?? asString(value?.workspaceKey),
    currentAgentName: asString(value?.current_agent_name) ?? asString(value?.currentAgentName),
    teamName: asString(value?.team_name) ?? asString(value?.teamName),
    workspaceRoot: asString(value?.workspace_root) ?? asString(value?.workspaceRoot),
  };
}

function readMemoryEntryArguments(value: Record<string, unknown> | undefined): {
  scope: string;
  fileName: string;
  sessionId?: string | null;
  agentName?: string | null;
  workspaceKey?: string | null;
  currentAgentName?: string | null;
  teamName?: string | null;
  workspaceRoot?: string | null;
} {
  return {
    ...readListMemoryIndexArguments(value),
    fileName: asString(value?.file_name) ?? asString(value?.fileName) ?? "",
  };
}

function readWriteMemoryArguments(value: Record<string, unknown> | undefined): {
  scope: string;
  name: string;
  description: string;
  memoryType: string;
  content: string;
  why?: string | null;
  howToApply?: string | null;
  sourceRunId?: string | null;
  sourceMessageId?: string | null;
  sessionId?: string | null;
  agentName?: string | null;
  workspaceKey?: string | null;
  currentAgentName?: string | null;
  teamName?: string | null;
  workspaceRoot?: string | null;
} {
  return {
    ...readListMemoryIndexArguments(value),
    name: asString(value?.name) ?? "",
    description: asString(value?.description) ?? "",
    memoryType: asString(value?.memory_type) ?? asString(value?.memoryType) ?? "",
    content: typeof value?.content === "string" ? value.content : "",
    why: asString(value?.why),
    howToApply: asString(value?.how_to_apply) ?? asString(value?.howToApply),
    sourceRunId: asString(value?.source_run_id) ?? asString(value?.sourceRunId),
    sourceMessageId: asString(value?.source_message_id) ?? asString(value?.sourceMessageId),
  };
}

function readArchiveMemoryArguments(value: Record<string, unknown> | undefined): {
  scope: string;
  fileName: string;
  sessionId?: string | null;
  agentName?: string | null;
  workspaceKey?: string | null;
  currentAgentName?: string | null;
  teamName?: string | null;
  workspaceRoot?: string | null;
} {
  return readMemoryEntryArguments(value);
}

function readFileArguments(value: Record<string, unknown> | undefined): {
  filePath: string;
  encoding?: string | null;
  offset?: number | null;
  limit?: number | null;
  filePathSpace?: string | null;
} {
  return {
    filePath: asString(value?.file_path) ?? asString(value?.filePath) ?? "",
    encoding: asString(value?.encoding),
    offset: asInteger(value?.offset),
    limit: asInteger(value?.limit),
    filePathSpace: asString(value?.file_path_space) ?? asString(value?.filePathSpace),
  };
}

function writeFileArguments(value: Record<string, unknown> | undefined): {
  content: unknown;
  filePath?: string | null;
  encoding?: string | null;
  mode?: string | null;
  filePathSpace?: string | null;
} {
  return {
    content: value?.content ?? "",
    filePath: asString(value?.file_path) ?? asString(value?.filePath),
    encoding: asString(value?.encoding),
    mode: asString(value?.mode),
    filePathSpace: asString(value?.file_path_space) ?? asString(value?.filePathSpace),
  };
}

function editFileArguments(value: Record<string, unknown> | undefined): {
  filePath: string;
  oldString: string;
  newString: string;
  encoding?: string | null;
  replaceAll?: boolean | null;
  filePathSpace?: string | null;
} {
  return {
    filePath: asString(value?.file_path) ?? asString(value?.filePath) ?? "",
    oldString: asString(value?.old_string) ?? asString(value?.oldString) ?? "",
    newString: typeof value?.new_string === "string" ? value.new_string : typeof value?.newString === "string" ? value.newString : "",
    encoding: asString(value?.encoding),
    replaceAll: typeof value?.replace_all === "boolean" ? value.replace_all : typeof value?.replaceAll === "boolean" ? value.replaceAll : null,
    filePathSpace: asString(value?.file_path_space) ?? asString(value?.filePathSpace),
  };
}

function previewDataStructureArguments(value: Record<string, unknown> | undefined): {
  filePath: string;
  encoding?: string | null;
  maxPreviewRows?: number | null;
  maxDepth?: number | null;
  maxFields?: number | null;
  filePathSpace?: string | null;
} {
  return {
    filePath: asString(value?.file_path) ?? asString(value?.filePath) ?? "",
    encoding: asString(value?.encoding),
    maxPreviewRows: asInteger(value?.max_preview_rows) ?? asInteger(value?.maxPreviewRows),
    maxDepth: asInteger(value?.max_depth) ?? asInteger(value?.maxDepth),
    maxFields: asInteger(value?.max_fields) ?? asInteger(value?.maxFields),
    filePathSpace: asString(value?.file_path_space) ?? asString(value?.filePathSpace),
  };
}

function readBashArguments(value: Record<string, unknown> | undefined): BashExecutionInput {
  return {
    command: asString(value?.command) ?? "",
    workingDir: asString(value?.working_dir) ?? asString(value?.workingDir),
    workingDirSpace: asString(value?.working_dir_space) ?? asString(value?.workingDirSpace),
    timeout: asInteger(value?.timeout),
    runInBackground: typeof value?.run_in_background === "boolean"
      ? value.run_in_background
      : typeof value?.runInBackground === "boolean"
        ? value.runInBackground
        : null,
    description: asString(value?.description),
  };
}

function readCallAgentArguments(value: Record<string, unknown> | undefined, callId: string | undefined): {
  agentName: string;
  task: string;
  contextHint?: string | null;
  callId?: string | null;
} {
  return {
    agentName: asString(value?.agent_name) ?? asString(value?.agentName) ?? "",
    task: asString(value?.task) ?? "",
    contextHint: asString(value?.context_hint) ?? asString(value?.contextHint),
    callId: callId ?? null,
  };
}

function readListChildAgentsArguments(value: Record<string, unknown> | undefined): {
  agentName?: string | null;
  limit?: number | null;
} {
  return {
    agentName: asString(value?.agent_name) ?? asString(value?.agentName),
    limit: asInteger(value?.limit),
  };
}

function readSendMessageArguments(value: Record<string, unknown> | undefined, callId: string | undefined): {
  childAgentId: string;
  message: string;
  callId?: string | null;
} {
  return {
    childAgentId: asString(value?.child_agent_id) ?? asString(value?.childAgentId) ?? "",
    message: asString(value?.message) ?? "",
    callId: callId ?? null,
  };
}

function errorResult(
  message: string,
  toolName: string,
  metadata: Record<string, unknown> = {},
): ToolExecutionResult<string> {
  return {
    success: false,
    tool_name: toolName,
    summary: message,
    answer: null,
    output_type: "error",
    content: message,
    metadata: {
      source_shape: "error",
      ...metadata,
    },
    artifacts: [],
    llm_hint: null,
  };
}

function successResult<T>(
  content: T,
  input: {
    summary: string;
    outputType: string;
    metadata: Record<string, unknown>;
    toolName: string;
  },
): ToolExecutionResult<T> {
  return {
    success: true,
    tool_name: input.toolName,
    summary: input.summary,
    answer: null,
    output_type: input.outputType,
    content,
    metadata: input.metadata,
    artifacts: [],
    llm_hint: null,
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asProvidedString(value: Record<string, unknown> | undefined, ...keys: string[]): string | null | undefined {
  if (!value) {
    return undefined;
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      return typeof value[key] === "string" ? value[key] : null;
    }
  }
  return undefined;
}

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map((item) => String(item)).filter((item) => item.trim().length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readPrompt(value: Record<string, unknown> | undefined): string | null {
  return asString(value?.prompt) ?? asString(value?.question) ?? asString(value?.message);
}

function readInputType(value: Record<string, unknown> | undefined): string {
  return asString(value?.input_type) === "select" ? "select" : "text";
}

function readOptions(value: Record<string, unknown> | undefined): string[] {
  if (!Array.isArray(value?.options)) {
    return [];
  }
  return value.options.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function buildApprovalMetadata(
  decision: RuntimeToolApprovalDecision,
  note = "",
): Record<string, unknown> {
  return {
    reason: decision.reason,
    note,
    ...(decision.reasonCodes.length ? { reason_codes: decision.reasonCodes } : {}),
    ...(decision.secondaryReasons.length ? { secondary_reasons: decision.secondaryReasons } : {}),
    ...(decision.approvedExternalPaths.length ? { approved_external_paths: decision.approvedExternalPaths } : {}),
  };
}

function withApprovalMetadata<T>(
  result: ToolExecutionResult<T>,
  decision: RuntimeToolApprovalDecision,
  note: string,
): ToolExecutionResult<T> {
  return {
    ...result,
    metadata: {
      ...result.metadata,
      approval: buildApprovalMetadata(decision, note),
      ...(note ? { approval_message: note } : {}),
    },
  };
}

export function isReadOnlyMemoryToolName(toolName: string): toolName is ReadOnlyMemoryToolName {
  return READ_ONLY_MEMORY_TOOL_NAMES.includes(toolName as ReadOnlyMemoryToolName);
}

function withApprovedExternalPaths(
  context: RuntimeToolExecutionContext,
  approvedExternalPaths: string[] | undefined,
): RuntimeToolExecutionContext {
  const merged = dedupeStrings([...(context.approvedExternalPaths ?? []), ...(approvedExternalPaths ?? [])]);
  return merged.length ? { ...context, approvedExternalPaths: merged } : context;
}

function approvalUnsupportedError(toolName: string, approvedExternalPaths: string[]): ToolExecutionResult<string> {
  return errorResult(`工具 ${toolName} 需要用户授权，但当前上下文不支持审批`, toolName, {
    approval: {
      reason: "路径越界访问需要审批",
      note: "",
      reason_codes: ["ask-path"],
      approved_external_paths: approvedExternalPaths,
    },
  });
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}
