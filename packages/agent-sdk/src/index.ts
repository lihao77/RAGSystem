/** @ragsystem/agent-sdk 公共导出。 */
export { createRuntime } from "./runtime.js";
export type { CreateRuntimeOptions, RunInput, RunHandle } from "./runtime.js";
export type { AgentProfile, ResolvedTier, TierMap, CompressionBudgetConfig, AgentBehavior, MemoryConfig, MessageInfo, RunStepRecord, RunRecord, RunStatus, MessageRole, ToolCallRef } from "./types.js";
export { DEFAULT_COMPRESSION_BUDGET } from "./types.js";
export type { KernelEvent, FirstTokenEvent, OutputDeltaEvent, IntentCompleteEvent, ToolCallEvent, ToolResultEvent, ObservationCompleteEvent, RuntimeErrorEvent, EventSink, Context, Protocol, ToolProvider, MessageRefresher, HookRegistry, HookPoint, ToolInstructionMode, RuntimeSession, RuntimeStore, RuntimeTx, KernelResult, KernelOutcome, PreparedRoundToolCall, KernelToolCall, KernelObservation, ToolExecutionResult, CreateRunInput, AddMessageInput, AddRunStepInput, InsertCompressionMessageInput } from "./contracts.js";
export { AgentKernel } from "./kernel.js";
export type { AgentKernelOptions } from "./kernel.js";
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
// 端口类型补全：消费端实现 ToolExecutor 端口所需（contracts + prompt/tool-types）。
export type { ToolExecutor, ToolExecutorCall, ToolExecContext, ToolWaitRequest, ToolWaitResult, ToolArtifact } from "./contracts.js";
export type { RuntimeToolDefinition, RuntimeToolReturns, RuntimeToolExample } from "./prompt/tool-types.js";
// Tools 模块（SDK 自带编排 + observation 渲染）
export { RuntimeToolProvider, executeToolCallRound, buildLlmFacingToolResult, renderToolResultContent, resolveToolArgumentReferences, materializeToolResult, buildToolReferenceErrorResult, buildToolExecutionErrorResult, runToolBatchWithScheduler, partitionToolCalls } from "./tools/index.js";
export type { RuntimeToolProviderOptions, ToolRoundExecutorOptions, ToolSchedulerCall, ToolSchedulerExecutor } from "./tools/index.js";
// Protocol module（SDK 自带协议解析 + 自动选择）
export { XmlProtocol, NativeHybridProtocol, createProtocol, resolveToolInstructionMode } from "./protocol/index.js";
export type { XmlProtocolDeps, NativeHybridProtocolDeps, ProtocolFactoryOptions, SelectedProtocol } from "./protocol/index.js";
export { renderSemanticChatMessage, renderXmlModelMessage, renderNativeModelMessage, StreamingRuntimeXmlParser, parseRuntimeToolCallsXml, serializeToolCallsToXml, renderRuntimeXmlProtocolInstruction, renderNativeXmlProtocolInstruction } from "./protocol/index.js";
export type { RuntimeXmlTag, RuntimeXmlParseEvent, ParsedToolCall, RuntimeToolCallParseResult } from "./protocol/index.js";
