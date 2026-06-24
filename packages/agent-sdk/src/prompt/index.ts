/** 提示词组装公共导出（设计稿 §7）。 */
export * from "./types.js";
export type { RuntimeToolDefinition, RuntimeToolReturns, RuntimeToolExample } from "./tool-types.js";
export { buildFullSystemPrompt, getAgentBaseSystemPrompt } from "./prompt-builder.js";
export { prepareToolsForPrompt, formatAllowedCallers, formatToolParameters } from "./tool-format.js";
export { buildPromptSystemSection, buildPromptGoalSection } from "./sections.js";
export type { AgentPromptContext } from "./types.js";
