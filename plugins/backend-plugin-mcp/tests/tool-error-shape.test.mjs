import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { renderToolResultContent } from "@ragsystem/agent-sdk";
import { McpService, normalizeToolResult } from "../dist/index.js";

/**
 * 回归:MCP 错误结果曾把 toolError(toolName, message) 参数传反,导致
 * content 只剩工具全名(LLM 观察文案渲染成一行 "[ERROR] mcp__xxx__yyy"),
 * 真实错误原因被塞进 toolName 字段无人展示。
 */

function createService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-mcp-err-"));
  const configPath = path.join(root, "mcp_servers.yaml");
  // YAML 是 JSON 超集,直接写 JSON 即可被 YAML.parse 读取。
  fs.writeFileSync(configPath, JSON.stringify({ servers: {} }));
  return new McpService({ configPath });
}

function connectedState(client) {
  return {
    status: "connected",
    client,
    config: { timeout: 5 },
    tools: [],
    resources: [],
    prompts: [],
  };
}

test("server 返回 isError 时错误文本落入 content,toolName 为工具全名", () => {
  const result = normalizeToolResult(
    "mcp__map_mcp__prepare_project",
    "map_mcp",
    "prepare_project",
    { isError: true, content: [{ type: "text", text: "project.xml 不存在: 路径无效" }] },
  );
  assert.equal(result.success, false);
  assert.equal(result.toolName, "mcp__map_mcp__prepare_project");
  assert.equal(result.content, "project.xml 不存在: 路径无效");
  assert.equal(result.summary, "project.xml 不存在: 路径无效");
});

test("server 返回 isError 且无文本时 content 为兜底文案而非工具名", () => {
  const result = normalizeToolResult("mcp__docs__search", "docs", "search", { isError: true, content: [] });
  assert.equal(result.success, false);
  assert.equal(result.content, "MCP 工具返回错误");
  assert.equal(result.toolName, "mcp__docs__search");
});

test("无效 MCP 工具名时 content 携带原因", async () => {
  const service = createService();
  const result = await service.callRuntimeTool("not_an_mcp_tool", {});
  assert.equal(result.success, false);
  assert.equal(result.toolName, "not_an_mcp_tool");
  assert.equal(result.content, "无效的 MCP 工具名: not_an_mcp_tool");
});

test("server 未连接时 content 携带原因,toolName 为工具全名", async () => {
  const service = createService();
  const result = await service.callRuntimeTool("mcp__map_mcp__prepare_project", {});
  assert.equal(result.success, false);
  assert.equal(result.toolName, "mcp__map_mcp__prepare_project");
  assert.equal(result.content, "MCP Server 'map_mcp' 未连接");
});

test("调用抛异常时 content 携带异常信息", async () => {
  const service = createService();
  service.connections.set(
    "map_mcp",
    connectedState({ callTool: async () => { throw new Error("boom: 输出目录无法创建"); } }),
  );
  const result = await service.callRuntimeTool("mcp__map_mcp__prepare_project", {});
  assert.equal(result.success, false);
  assert.equal(result.toolName, "mcp__map_mcp__prepare_project");
  assert.ok(result.content.includes("MCP 工具调用失败"), `content 应包含失败前缀: ${result.content}`);
  assert.ok(result.content.includes("boom: 输出目录无法创建"), `content 应包含异常信息: ${result.content}`);
});

test("失败结果的 LLM 观察文案展示真实错误原因而非裸工具名", () => {
  const result = normalizeToolResult(
    "mcp__map_mcp__prepare_project",
    "map_mcp",
    "prepare_project",
    { isError: true, content: [{ type: "text", text: "project.xml 不存在: 路径无效" }] },
  );
  const observation = renderToolResultContent({
    callId: "call_1",
    toolName: "mcp__map_mcp__prepare_project",
    result,
  });
  assert.ok(observation.includes("[ERROR] project.xml 不存在"), `观察文案应含真实错误: ${observation}`);
  assert.ok(!observation.includes("[ERROR] mcp__map_mcp__prepare_project"), `不应只剩裸工具名: ${observation}`);
});
