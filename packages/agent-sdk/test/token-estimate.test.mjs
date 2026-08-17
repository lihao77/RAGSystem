import assert from "node:assert/strict";
import test from "node:test";

import { estimateRequestTokenUsage } from "../dist/compression/token-estimate.js";

test("估算细分：system 消息、tools schema 与 mcp/技能工具分开计数", () => {
  const usage = estimateRequestTokenUsage({
    messages: [
      { role: "system", content: "你是助手，遵守安全约束" },
      { role: "user", content: "你好" },
    ],
    tools: [
      { type: "function", function: { name: "builtin", description: "内置工具", parameters: {} }, source: "runtime_builtin" },
      { type: "function", function: { name: "mcp_search", description: "MCP 搜索工具", parameters: {} }, source: "mcp" },
      { type: "function", function: { name: "skill_run", description: "技能执行工具", parameters: {} }, source: "knowledge" },
    ],
  });

  assert.ok(usage.toolSchemaTokens > 0, "tools schema 应计入");
  assert.ok(usage.mcpToolTokens > 0, "mcp 来源工具应单独计数");
  assert.ok(usage.knowledgeToolTokens > 0, "knowledge(技能)来源工具应单独计数");
  // 工具 schema 已并入 systemPromptTokens（预算语义不变），system 文本部分仍为正。
  assert.ok(usage.systemPromptTokens - usage.toolSchemaTokens > 0, "system 消息文本独立于工具 schema");
  assert.equal(usage.totalTokens, usage.systemPromptTokens + usage.historyTokens);
});

test("无工具时不产生工具细分字段值（均为 0）", () => {
  const usage = estimateRequestTokenUsage({
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(usage.toolSchemaTokens, 0);
  assert.equal(usage.mcpToolTokens, 0);
  assert.equal(usage.knowledgeToolTokens, 0);
  assert.equal(usage.totalTokens, usage.systemPromptTokens + usage.historyTokens);
});
