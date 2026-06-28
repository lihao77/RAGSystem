/** @ragsystem/agent-sdk 公共导出。 */
export { createRuntime } from "./runtime.js";
export type { CreateRuntimeOptions, RunInput, RunHandle } from "./runtime.js";
// 事件 Hook 系统
export { createHookRegistry, EMPTY_HOOK_OUTPUT } from "./hooks/index.js";
export type { HookEvent, HookHandler, HookInputMap, HookOutputMap, HookRegistry, HookDecision, ToolBeforeOutput, ToolAfterOutput, RoundBeforeOutput, BaseHookOutput, RunBeforeInput, RunAfterInput, RoundBeforeInput, RoundAfterInput, ToolBeforeInput, ToolAfterInput, ToolErrorInput } from "./hooks/index.js";
export type { AgentProfile, ResolvedTier, TierMap, CompressionBudgetConfig, AgentBehavior, MessageInfo, RunStepRecord, RunRecord, RunStatus, MessageRole, ToolCallRef } from "./types.js";
export { DEFAULT_COMPRESSION_BUDGET } from "./types.js";
export type { KernelEvent, FirstTokenEvent, OutputDeltaEvent, IntentCompleteEvent, ToolCallEvent, ToolResultEvent, ObservationCompleteEvent, RuntimeErrorEvent, ContextUsageEvent, EventSink, Context, Protocol, ToolProvider, MessageRefresher, ToolInstructionMode, RuntimeSession, RuntimeStore, RuntimeTx, KernelResult, KernelOutcome, PreparedRoundToolCall, KernelToolCall, KernelObservation, ToolExecutionResult, CreateRunInput, AddMessageInput, AddRunStepInput, InsertCompressionMessageInput, PermissionPolicy, ApprovalInteraction, ToolApprovalInput, ToolApprovalDecision, ApprovalRequest, ApprovalResolution } from "./contracts.js";
export { AgentKernel } from "./kernel.js";
export type { AgentKernelOptions, ContextUsageProvider } from "./kernel.js";
export { KernelContext } from "./kernel-context.js";
export { Dispatcher } from "./dispatcher.js";
export type { DispatcherRunContext } from "./dispatcher.js";
export { SqliteRuntimeStore } from "./store/sqlite-store.js";
export type { SqliteStoreOptions, StoreDb } from "./store/sqlite-store.js";
// Context 组装原语 + 端口（消费端 snapshot/调试与 createRuntime run 路径同源，单一实现，消除 backend 平行组装）
export { AgentContextBuilder, RecentMessagesContextSource, filterHistoryMessages, resolveCompressionView, resolveHistoryView, messagesToConversation } from "./context/index.js";
export type { AgentContextBuilderOptions, AgentContext, AgentContextRequest, AgentContextSource, AgentContextContribution, ResolvedAgentContextRequest, ConversationHistoryPort, SessionMetadataPort } from "./context/types.js";
export { AgentContextCompressionService } from "./compression/context-compression.js";
export { compactSession } from "./compression/compact-session.js";
export type { CompactSessionInput, CompactSessionResult } from "./compression/compact-session.js";
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
export type { AgentPromptContext } from "./prompt/types.js";
// Tools 模块（SDK 自带编排 + observation 渲染）
export { RuntimeToolProvider, executeToolCallRound, buildLlmFacingToolResult, renderToolResultContent, resolveToolArgumentReferences, materializeToolResult, buildToolReferenceErrorResult, buildToolExecutionErrorResult, runToolBatchWithScheduler, partitionToolCalls } from "./tools/index.js";
export type { RuntimeToolProviderOptions, ToolRoundExecutorOptions, ToolSchedulerCall, ToolSchedulerExecutor } from "./tools/index.js";
// LLM 协议模块（工具调用编码：XML/native 协议解析 + 自动选择）
export { XmlProtocol, NativeHybridProtocol, createProtocol, resolveToolInstructionMode } from "./llm-protocol/index.js";
export type { XmlProtocolDeps, NativeHybridProtocolDeps, ProtocolFactoryOptions, SelectedProtocol } from "./llm-protocol/index.js";
export { renderSemanticChatMessage, renderXmlModelMessage, renderNativeModelMessage, StreamingRuntimeXmlParser, parseRuntimeToolCallsXml, serializeToolCallsToXml, renderRuntimeXmlProtocolInstruction, renderNativeXmlProtocolInstruction } from "./llm-protocol/index.js";
export type { RuntimeXmlTag, RuntimeXmlParseEvent, ParsedToolCall, RuntimeToolCallParseResult } from "./llm-protocol/index.js";
