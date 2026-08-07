/** 工具执行模块公共导出。 */
// Tool 富模型
export { buildTool, toolToDefinition } from "./tool.js";
export type { Tool, BuildToolInput, InputSchema, ToolAccessDecision, RiskLevel, ToolCaller, ToolSource } from "./tool.js";
export { buildApprovalDescription, categoryRisk, classifyCommand, validateCommand } from "./command-policy.js";
export type { CommandCategory } from "./command-policy.js";
// Registry
export { createToolRegistry } from "./registry.js";
export type { ToolRegistry, ToolRegistryOptions } from "./registry.js";
// Validation
export { validateToolInput } from "./validation.js";
export type { ToolValidationResult, ToolValidationSuccess, ToolValidationFailure } from "./validation.js";
// Preparer
export { prepareTool } from "./preparer.js";
export type { PreparedTool, PrepareResult, ToolPreparerOptions } from "./preparer.js";
// RuntimeToolProvider（ToolProvider 端口默认实现）
export { RuntimeToolProvider } from "./runtime-tool-provider.js";
export type { RuntimeToolProviderOptions } from "./runtime-tool-provider.js";
// 编排引擎
export { executeToolCallRound } from "./tool-round-executor.js";
export type { ToolRoundExecutorOptions } from "./tool-round-executor.js";
// Observation 渲染
export { buildLlmFacingToolResult, buildToolMediaModelContent, renderToolResultContent } from "./observation.js";
// 工具引用/错误
export { resolveToolArgumentReferences, collectResultPlaceholders, collectResultReferenceIndexes, materializeToolResult, buildToolReferenceErrorResult, buildToolExecutionErrorResult } from "./tool-references.js";
// 并发调度
export { runToolBatchWithScheduler, partitionToolCalls } from "./scheduler.js";
export type { ToolSchedulerCall, ToolSchedulerExecutor } from "./scheduler.js";
export { withLeaseLock } from "./lease-lock.js";
export type { LeaseLockOptions } from "./lease-lock.js";
