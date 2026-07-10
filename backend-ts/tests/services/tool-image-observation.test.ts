import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  buildLlmFacingToolResult,
  buildToolMediaModelContent,
  buildTool,
  createToolRegistry,
  executeToolCallRound,
  NativeHybridProtocol,
  XmlProtocol,
  type AgentProfile,
  type KernelObservation,
  type KernelToolCall,
  type ToolExecutionResult,
} from "@ragsystem/agent-sdk";
import type { LlmClient, ProviderConfig } from "@ragsystem/agent-llm";

const roots: string[] = [];
const PNG_BASE64 = "iVBORw0KGgo=";
const provider: ProviderConfig = { key: "vision", name: "vision", provider_type: "openai", supports_vision: true };
const profile: AgentProfile = {
  agentName: "agent",
  displayName: "Agent",
  behavior: { systemPrompt: "", compressionTriggerRatio: null, summarizeMaxTokens: null, preserveRecentTurns: null },
  llmTiers: { default: { provider, modelName: "model", temperature: null, maxCompletionTokens: null, maxContextTokens: 128000, extraParams: {} } },
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function result(): ToolExecutionResult {
  return {
    success: true,
    toolName: "mcp__demo__screenshot",
    summary: "screenshot complete",
    answer: null,
    outputType: "text",
    content: "done",
    metadata: {},
    artifacts: [],
    media: [{ kind: "image", mimeType: "image/png", source: { type: "base64", data: PNG_BASE64 } }],
    llmHint: null,
  };
}

describe("tool image observation", () => {
  it("renders the final delivered image count after validation and limits", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-tool-image-count-"));
    roots.push(root);
    const media = Array.from({ length: 5 }, () => ({
      kind: "image" as const,
      mimeType: "image/png" as const,
      source: { type: "base64" as const, data: PNG_BASE64 },
    }));
    media[1] = { ...media[1]!, source: { type: "base64", data: "not-an-image" } };
    const registry = createToolRegistry({ tools: [buildTool({
      name: "screenshot",
      description: "returns screenshots",
      call: () => ({ ...result(), toolName: "screenshot", media }),
    })] });

    const observations = await executeToolCallRound([
      { index: 0, callId: "call-1", toolName: "screenshot", arguments: {} },
    ], {
      registry,
      toolContext: toolContext("s1"),
      dataRoot: root,
      round: 1,
      agentName: "agent",
      profile,
      provider,
      events: { emit() {} },
    });

    expect(observations[0]?.observation).toContain("[工具返回 3 张图片]");
    expect(observations[0]?.observation).not.toContain("5 张图片");
    expect(observations[0]?.modelContent).toEqual(expect.arrayContaining([
      { type: "text", text: expect.stringContaining("[工具返回 3 张图片]") },
    ]));
    expect((observations[0]?.modelContent as unknown[]).filter((part) => (part as { type?: string }).type === "image_url")).toHaveLength(3);
  });

  it("materializes image bytes and builds model-only image content", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-tool-image-"));
    roots.push(root);
    const toolResult = result();

    const content = await buildToolMediaModelContent({
      result: toolResult,
      observation: "<tool_result>done</tool_result>",
      toolContext: {
        sessionId: "s1",
        runId: null,
        taskId: null,
        requestId: null,
        parentCallId: null,
        toolCallId: null,
        round: null,
        order: null,
        roundIndex: null,
      },
      profile,
      provider,
      dataRoot: root,
    });

    expect(content).toHaveLength(2);
    expect(content?.[1]).toMatchObject({ type: "image_url", image_url: { detail: "auto" } });
    expect(toolResult.media?.[0]?.source.type).toBe("file");
    expect(toolResult.artifacts[0]).toMatchObject({ artifactType: "image", mimeType: "image/png", size: 8 });
    expect(fs.existsSync(toolResult.artifacts[0]!.path)).toBe(true);
    const index = fs.readFileSync(path.join(root, "sessions", "s1", "transient", "artifact_index.jsonl"), "utf8");
    expect(index).not.toContain(PNG_BASE64);
  });

  it("keeps successful images when a later image fails validation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-tool-image-partial-"));
    roots.push(root);
    const toolResult = result();
    toolResult.media?.push({ kind: "image", mimeType: "image/png", source: { type: "file", path: path.join(root, "missing.png") } });

    const content = await buildToolMediaModelContent({
      result: toolResult,
      observation: "done",
      toolContext: toolContext("s1"),
      profile,
      provider,
      dataRoot: root,
    });

    expect(content?.filter((part) => part.type === "image_url")).toHaveLength(1);
    expect(toolResult.media).toHaveLength(1);
    expect(toolResult.media?.[0]?.source.type).toBe("file");
    expect(toolResult.metadata).toMatchObject({ tool_result_media_rejected: 1 });
    expect(JSON.stringify(toolResult.media)).not.toContain(PNG_BASE64);
  });

  it("rejects unsafe session paths for image and large-payload artifacts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-tool-image-path-"));
    roots.push(root);
    const toolResult = result();
    const unsafeContext = toolContext("../../outside");

    const mediaContent = await buildToolMediaModelContent({
      result: toolResult,
      observation: "done",
      toolContext: unsafeContext,
      profile,
      provider,
      dataRoot: root,
    });
    const largeResult = result();
    delete largeResult.media;
    largeResult.content = "x".repeat(5_000);
    largeResult.artifacts = [];
    await buildLlmFacingToolResult({
      result: largeResult,
      toolName: largeResult.toolName,
      toolContext: unsafeContext,
      profile,
      provider,
      dataRoot: root,
    });

    expect(mediaContent).toBeNull();
    expect(toolResult.media).toEqual([]);
    expect(largeResult.artifacts).toEqual([]);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("keeps native tool replies textual and appends a labelled user image message", () => {
    const { call, observation } = protocolInput();
    const protocol = new NativeHybridProtocol({ llm: {} as LlmClient, events: { emit() {} }, getTools: () => [] });
    const messages = protocol.renderObservations([call], [observation]);

    expect(messages[0]).toMatchObject({ role: "tool", tool_call_id: "call-1", content: "text observation" });
    expect(messages[1]).toMatchObject({ role: "user" });
    expect(messages[1]?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: expect.stringContaining("call_id=call-1") }),
      expect.objectContaining({ type: "image_url" }),
    ]));
  });

  it("splits persisted native tool image parts after all consecutive tool replies", () => {
    const protocol = new NativeHybridProtocol({ llm: {} as LlmClient, events: { emit() {} }, getTools: () => [] });
    const messages = protocol.toModelMessages([
      { role: "tool", tool_call_id: "call-1", name: "screenshot", content: [
        { type: "text", text: "one" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      ] },
      { role: "tool", tool_call_id: "call-2", name: "lookup", content: "two" },
      { role: "assistant", content: "next" },
    ]);

    expect(messages.map((message) => message.role)).toEqual(["tool", "tool", "user", "assistant"]);
    expect(messages[0]?.content).toBe("one");
    expect(messages[2]?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image_url" })]));
  });

  it("projects XML tool replies as a multimodal user message", () => {
    const { call, observation } = protocolInput();
    const protocol = new XmlProtocol({ llm: {} as LlmClient, events: { emit() {} }, getTools: () => [] });
    const messages = protocol.toModelMessages(protocol.renderObservations([call], [observation]));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user", content: observation.modelContent });
  });
});

function toolContext(sessionId: string) {
  return {
    sessionId,
    runId: null,
    taskId: null,
    requestId: null,
    parentCallId: null,
    toolCallId: null,
    round: null,
    order: null,
    roundIndex: null,
  };
}

function protocolInput(): { call: KernelToolCall; observation: KernelObservation } {
  const call: KernelToolCall = { index: 0, callId: "call-1", toolName: "screenshot", arguments: {} };
  const toolResult = result();
  const modelContent = [
    { type: "text" as const, text: "text observation" },
    { type: "image_url" as const, image_url: { url: "data:image/png;base64,cG5n" } },
  ];
  return {
    call,
    observation: { ...call, result: toolResult, observation: "text observation", modelContent },
  };
}
