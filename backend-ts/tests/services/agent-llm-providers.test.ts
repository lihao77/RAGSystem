import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAnthropicBody,
  externalCallPolicy,
  OpenAiCompatibleClient,
  type LlmRequest,
  type LlmStreamChunk,
  type ProviderConfig,
} from "@ragsystem/agent-llm";

afterEach(() => {
  externalCallPolicy.reset();
  vi.restoreAllMocks();
});

describe("agent-llm provider adapters", () => {
  it("assembles Anthropic thinking/signature blocks and sends them back before tool_use", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([
      anthropicEvent("message_start", { type: "message_start", message: { usage: { input_tokens: 11, output_tokens: 0 } } }),
      anthropicEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      anthropicEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "private thought" } }),
      anthropicEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-123" } }),
      anthropicEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
      anthropicEvent("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call-1", name: "lookup", input: {} } }),
      anthropicEvent("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"q\":\"x\"}" } }),
      anthropicEvent("content_block_stop", { type: "content_block_stop", index: 1 }),
      anthropicEvent("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 23 } }),
      anthropicEvent("message_stop", { type: "message_stop" }),
    ]));

    const request = anthropicRequest();
    const chunks: LlmStreamChunk[] = [];
    const result = await new OpenAiCompatibleClient().stream(request, (chunk) => {
      chunks.push(chunk);
    });

    expect(chunks.flatMap((chunk) => chunk.toolCalls ?? [])).toEqual([
      { id: "call-1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } },
    ]);
    expect(chunks.map((chunk) => chunk.content).join("")).toBe("");
    expect(result).toMatchObject({
      content: "",
      reasoning: "private thought",
      reasoningBlocks: [{ type: "thinking", thinking: "private thought", signature: "sig-123" }],
      finishReason: "tool_use",
      usage: { inputTokens: 11, outputTokens: 23, totalTokens: 34 },
    });
    expect(result.toolCalls).toHaveLength(1);

    const nextBody = buildAnthropicBody({
      ...request,
      messages: [
        { role: "user", content: "find x" },
        {
          role: "assistant",
          content: "",
          reasoning_blocks: result.reasoningBlocks!,
          tool_calls: result.toolCalls!,
        },
        { role: "tool", tool_call_id: "call-1", content: "found" },
      ],
    });
    const assistant = (nextBody.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>)[1]!;
    expect(assistant.content.map((block) => block.type)).toEqual(["thinking", "tool_use"]);
    expect(assistant.content[0]).toMatchObject({ signature: "sig-123", thinking: "private thought" });
  });

  it("enables Anthropic thinking from provider config and omits incompatible temperature", () => {
    const body = buildAnthropicBody(anthropicRequest({
      provider: { thinking_budget_tokens: 2048 },
      temperature: 0.7,
    }));
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(body.temperature).toBeUndefined();
  });

  it("streams OpenAI Responses text, function calls and usage", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([
      responseEvent("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call-r", name: "search", arguments: "" } }),
      responseEvent("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: 0, delta: "{\"term\":" }),
      responseEvent("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: 0, delta: "\"docs\"}" }),
      responseEvent("response.output_text.delta", { type: "response.output_text.delta", delta: "working" }),
      responseEvent("response.completed", { type: "response.completed", response: { status: "completed", usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 } } }),
    ]));
    const chunks: LlmStreamChunk[] = [];
    const result = await new OpenAiCompatibleClient().stream({
      messages: [{ role: "user", content: "search" }],
      model: "gpt-5",
      provider: { key: "openai", name: "OpenAI", provider_type: "openai_resp", api_key: "test" },
    }, (chunk) => {
      chunks.push(chunk);
    });

    expect(result.content).toBe("working");
    expect(result.toolCalls).toEqual([
      { id: "call-r", type: "function", function: { name: "search", arguments: "{\"term\":\"docs\"}" } },
    ]);
    expect(result.usage?.totalTokens).toBe(12);
    expect(chunks.some((chunk) => chunk.content === "working")).toBe(true);
  });

  it("normalizes reasoning_details and array content from OpenAI-compatible responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          content: [{ type: "text", text: "answer" }],
          reasoning_details: [{ type: "reasoning.text", text: "hidden" }],
        },
        finish_reason: "stop",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(new OpenAiCompatibleClient().complete({
      messages: [{ role: "user", content: "hello" }],
      model: "model",
      provider: { key: "proxy", name: "Proxy", provider_type: "openai_proxy", api_key: "test" },
    })).resolves.toMatchObject({ content: "answer", reasoning: "hidden", finishReason: "stop" });
  });
});

function anthropicRequest(overrides: {
  messages?: LlmRequest["messages"];
  provider?: Partial<ProviderConfig>;
  temperature?: number | null;
} = {}): LlmRequest {
  return {
    messages: overrides.messages ?? [{ role: "user", content: "hello" }],
    model: "claude-sonnet-4-5",
    provider: {
      key: "anthropic",
      name: "Anthropic",
      provider_type: "anthropic",
      api_key: "test",
      ...overrides.provider,
    },
    ...(overrides.temperature !== undefined ? { temperature: overrides.temperature } : {}),
  };
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function anthropicEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function responseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
