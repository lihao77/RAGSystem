/** @ragsystem/agent-sdk 公共导出。 */
export { createRuntime } from "./runtime.js";
export type { CreateRuntimeOptions, PreviewInput, PreviewResult, RunInput, RunHandle } from "./runtime.js";
// 事件 Hook 系统
export { createHookRegistry, EMPTY_HOOK_OUTPUT } from "./hooks/index.js";
export type { HookEvent, HookHandler, HookInputMap, HookOutputMap, HookRegistry, HookDecision, ToolBeforeOutput, ToolAfterOutput, RoundBeforeOutput, BaseHookOutput, RunBeforeInput, RunAfterInput, RoundBeforeInput, RoundAfterInput, ToolBeforeInput, ToolAfterInput, ToolErrorInput } from "./hooks/index.js";
export type { AgentProfile, ResolvedTier, TierMap, CompressionBudgetConfig, AgentBehavior, MessageInfo, RunStepRecord, RunRecord, RunStatus, MessageRole, ToolCallRef } from "./types.js";
export { DEFAULT_COMPRESSION_BUDGET } from "./types.js";
export type { KernelEvent, FirstTokenEvent, OutputDeltaEvent, IntentCompleteEvent, ToolCallEvent, ToolResultEvent, RuntimeErrorEvent, ContextUsageEvent, EventSink, Context, Protocol, ToolProvider, MessageRefresher, ToolInstructionMode, RuntimeSession, KernelResult, KernelOutcome, PreparedRoundToolCall, KernelToolCall, KernelObservation, ToolExecutionResult, ToolResultMedia } from "./contracts.js";
export { AgentKernel } from "./kernel.js";
export type { AgentKernelOptions, ContextUsageProvider } from "./kernel.js";
export { KernelContext } from "./kernel-context.js";
export { Dispatcher } from "./dispatcher.js";
export { estimateTokens, countMessagesTokens } from "./compression/token-estimate.js";
export { resolveContextBudget } from "./llm-params/budget.js";
export { resolveSummaryTierCandidates } from "./llm-params/summary-tier.js";
export { readTierParams } from "./llm-params/tier-params.js";
// Tool 富模型（SDK 定义的工具接口）
export { buildTool, toolToDefinition } from "./tools/tool.js";
export type { Tool, BuildToolInput, InputSchema, ToolAccessDecision, RiskLevel, ToolCaller, ToolSource } from "./tools/tool.js";
// ToolRegistry
export { createToolRegistry } from "./tools/registry.js";
export type { ToolRegistry, ToolRegistryOptions } from "./tools/registry.js";
// Validation
export { validateToolInput } from "./tools/validation.js";
export type { ToolValidationResult, ToolValidationSuccess, ToolValidationFailure } from "./tools/validation.js";
// Preparer
export { prepareTool } from "./tools/preparer.js";
export type { PreparedTool, PrepareResult, ToolPreparerOptions } from "./tools/preparer.js";
export type { ToolExecContext, ToolWaitRequest, ToolWaitResult, ToolArtifact } from "./contracts.js";
export type { RuntimeToolDefinition, RuntimeToolReturns, RuntimeToolExample } from "./prompt/tool-types.js";
// Prompt 模块（system prompt 构建——与内核 makeContextPort 同源）
export { buildFullSystemPrompt, getAgentBaseSystemPrompt } from "./prompt/prompt-builder.js";
export type { AgentPromptContext } from "./prompt/types.js";
// Tools 模块（SDK 自带编排 + observation 渲染）
export { RuntimeToolProvider, executeToolCallRound, buildLlmFacingToolResult, buildToolMediaModelContent, renderToolResultContent, withArtifactIndexLock, withLeaseLock, resolveToolArgumentReferences, materializeToolResult, buildToolReferenceErrorResult, buildToolExecutionErrorResult, runToolBatchWithScheduler, partitionToolCalls } from "./tools/index.js";
export type { RuntimeToolProviderOptions, ToolRoundExecutorOptions, ToolSchedulerCall, ToolSchedulerExecutor, ArtifactIndexLockOptions, LeaseLockOptions } from "./tools/index.js";
// LLM 协议模块（工具调用编码：XML/native 协议解析 + 自动选择）
export { XmlProtocol, NativeHybridProtocol, createProtocol, resolveToolInstructionMode } from "./llm-protocol/index.js";
export type { XmlProtocolDeps, NativeHybridProtocolDeps, ProtocolFactoryOptions, SelectedProtocol } from "./llm-protocol/index.js";
export { renderXmlModelMessage, renderNativeModelMessage, StreamingRuntimeXmlParser, parseRuntimeToolCallsXml, serializeToolCallsToXml, renderRuntimeXmlProtocolInstruction, renderNativeXmlProtocolInstruction } from "./llm-protocol/index.js";
export type { RuntimeXmlTag, RuntimeXmlParseEvent, ParsedToolCall, RuntimeToolCallParseResult } from "./llm-protocol/index.js";
