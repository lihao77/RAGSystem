/** @ragsystem/agent-sdk 公共导出。 */
export { createRuntime } from "./runtime.js";
export type { CreateRuntimeOptions, RunInput, RunHandle } from "./runtime.js";
// 事件 Hook 系统
export { createHookRegistry, EMPTY_HOOK_OUTPUT } from "./hooks/index.js";
export type { HookEvent, HookHandler, HookInputMap, HookOutput, HookRegistry, RunBeforeInput, RunAfterInput, RoundBeforeInput, RoundAfterInput, ToolBeforeInput, ToolAfterInput, ToolErrorInput } from "./hooks/index.js";
export type { AgentProfile, ResolvedTier, TierMap, CompressionBudgetConfig, AgentBehavior, MemoryConfig, MessageInfo, RunStepRecord, RunRecord, RunStatus, MessageRole, ToolCallRef } from "./types.js";
export { DEFAULT_COMPRESSION_BUDGET } from "./types.js";
export type { KernelEvent, FirstTokenEvent, OutputDeltaEvent, IntentCompleteEvent, ToolCallEvent, ToolResultEvent, ObservationCompleteEvent, RuntimeErrorEvent, ContextUsageEvent, EventSink, Context, Protocol, ToolProvider, MessageRefresher, ToolInstructionMode, RuntimeSession, RuntimeStore, RuntimeTx, KernelResult, KernelOutcome, PreparedRoundToolCall, KernelToolCall, KernelObservation, ToolExecutionResult, CreateRunInput, AddMessageInput, AddRunStepInput, InsertCompressionMessageInput, PermissionPolicy, ApprovalInteraction, ToolApprovalInput, ToolApprovalDecision, ApprovalRequest, ApprovalResolution } from "./contracts.js";
export { AgentKernel } from "./kernel.js";
export type { AgentKernelOptions, ContextUsageProvider } from "./kernel.js";
export { KernelContext } from "./kernel-context.js";
export { Dispatcher } from "./dispatcher.js";
export type { DispatcherRunContext } from "./dispatcher.js";
export { SqliteRuntimeStore } from "./store/sqlite-store.js";
export type { SqliteStoreOptions, StoreDb } from "./store/sqlite-store.js";
export { AgentContextBuilder } from "./context/context-builder.js";
export { MemoryStore } from "./memory/memory-store.js";
export { AgentContextCompressionService } from "./compression/context-compression.js";
export { createCompactionHook } from "./compression/compaction-hook.js";
export { resolveContextBudget } from "./llm-params/budget.js";
export { resolveSummaryTierCandidates } from "./llm-params/summary-tier.js";
export { readTierParams } from "./llm-params/tier-params.js";
// Tool 富模型（SDK 定义的工具接口）
export { buildTool, toolToDefinition } from "./tools/tool.js";
export type { Tool, BuildToolInput, InputSchema, ToolPermissionResult, RiskLevel, ToolCaller, ToolSource } from "./tools/tool.js";
// ToolRegistry
export { createToolRegistry } from "./tools/registry.js";
export type { ToolRegistry, ToolRegistryOptions } from "./tools/registry.js";
// Validation
export { validateToolInput } from "./tools/validation.js";
export type { ToolValidationResult, ToolValidationSuccess, ToolValidationFailure } from "./tools/validation.js";
// Preparer
export { prepareTool } from "./tools/preparer.js";
export type { PreparedTool, PrepareResult, ToolPreparerOptions } from "./tools/preparer.js";
// 端口类型（ToolExecutor deprecated，保留供过渡；新代码用 Tool + ToolRegistry）
export type { ToolExecutor, ToolExecutorCall, ToolExecContext, ToolWaitRequest, ToolWaitResult, ToolArtifact } from "./contracts.js";
export type { RuntimeToolDefinition, RuntimeToolReturns, RuntimeToolExample } from "./prompt/tool-types.js";
// Prompt 模块（system prompt 构建——与内核 makeContextPort 同源）
export { buildFullSystemPrompt, getAgentBaseSystemPrompt } from "./prompt/prompt-builder.js";
export type { AgentPromptContext, AgentPromptSkill, AgentPromptDelegatedAgent } from "./prompt/types.js";
// Preview 模块（调试用：组模型真实收到的请求，不调 LLM）
export { previewLlmRequest } from "./preview.js";
export type { PreviewLlmRequestInput, PreviewLlmRequestResult } from "./preview.js";
// Tools 模块（SDK 自带编排 + observation 渲染）
export { RuntimeToolProvider, executeToolCallRound, buildLlmFacingToolResult, renderToolResultContent, resolveToolArgumentReferences, materializeToolResult, buildToolReferenceErrorResult, buildToolExecutionErrorResult, runToolBatchWithScheduler, partitionToolCalls } from "./tools/index.js";
export type { RuntimeToolProviderOptions, ToolRoundExecutorOptions, ToolSchedulerCall, ToolSchedulerExecutor } from "./tools/index.js";
// Protocol module（SDK 自带协议解析 + 自动选择）
export { XmlProtocol, NativeHybridProtocol, createProtocol, resolveToolInstructionMode } from "./protocol/index.js";
export type { XmlProtocolDeps, NativeHybridProtocolDeps, ProtocolFactoryOptions, SelectedProtocol } from "./protocol/index.js";
export { renderSemanticChatMessage, renderXmlModelMessage, renderNativeModelMessage, StreamingRuntimeXmlParser, parseRuntimeToolCallsXml, serializeToolCallsToXml, renderRuntimeXmlProtocolInstruction, renderNativeXmlProtocolInstruction } from "./protocol/index.js";
export type { RuntimeXmlTag, RuntimeXmlParseEvent, ParsedToolCall, RuntimeToolCallParseResult } from "./protocol/index.js";
