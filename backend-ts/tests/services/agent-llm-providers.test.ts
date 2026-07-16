import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAnthropicBody,
  externalCallPolicy,
  OpenAiCompatibleClient,
  type LlmRequest,
  type LlmStreamChunk,
  type ProviderConfig,
} from "@ragsystem/agent-llm";
import { resolveToolInstructionMode } from "@ragsystem/agent-sdk";

afterEach(() => {
  externalCallPolicy.reset();
  vi.restoreAllMocks();
});

describe("agent-llm provider adapters", () => {
  it("selects native tool calling for function-capable OpenAI Responses providers", () => {
    expect(resolveToolInstructionMode({
      key: "openai",
      name: "OpenAI",
      provider_type: "openai_resp",
      supports_function_calling: true,
    })).toBe("native");
    expect(resolveToolInstructionMode({
      key: "openai",
      name: "OpenAI",
      provider_type: "openai_resp",
      supports_function_calling: false,
    })).toBe("xml");
  });

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
      providerContinuation: {
        protocol: "anthropic_messages",
        toolCallIds: ["call-1"],
      },
    });
    expect(result.toolCalls).toHaveLength(1);

    const nextBody = buildAnthropicBody({
      ...request,
      messages: [
        { role: "user", content: "find x" },
        {
          role: "assistant",
          content: "",
          provider_continuation: result.providerContinuation!,
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
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(sseResponse([
      responseEvent("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs-1", encrypted_content: "opaque" } }),
      responseEvent("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs-1", encrypted_content: "opaque" } }),
      responseEvent("response.output_item.added", { type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "call-r", name: "search", arguments: "" } }),
      responseEvent("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: 1, delta: "{\"term\":" }),
      responseEvent("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: 1, delta: "\"docs\"}" }),
      responseEvent("response.output_text.delta", { type: "response.output_text.delta", delta: "working" }),
      responseEvent("response.completed", { type: "response.completed", response: { status: "completed", usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 } } }),
    ]))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "completed",
        output_text: "done",
        output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const chunks: LlmStreamChunk[] = [];
    const result = await new OpenAiCompatibleClient().stream({
      messages: [{ role: "user", content: "search" }],
      model: "gpt-5",
      provider: { key: "openai", name: "OpenAI", provider_type: "openai_resp", api_key: "test" },
      promptCacheKey: "ragsystem:test-cache-key",
    }, (chunk) => {
      chunks.push(chunk);
    });

    expect(result.content).toBe("working");
    expect(result.toolCalls).toEqual([
      { id: "call-r", type: "function", function: { name: "search", arguments: "{\"term\":\"docs\"}" } },
    ]);
    expect(result.usage?.totalTokens).toBe(12);
    expect(result.providerContinuation).toEqual({
      protocol: "openai_responses",
      toolCallIds: ["call-r"],
      anchorCallId: "call-r",
      reasoningItems: [{ type: "reasoning", id: "rs-1", encrypted_content: "opaque" }],
    });
    expect(chunks.some((chunk) => chunk.content === "working")).toBe(true);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { prompt_cache_key?: string };
    expect(firstBody.prompt_cache_key).toBe("ragsystem:test-cache-key");

    await new OpenAiCompatibleClient().complete({
      messages: [
        { role: "user", content: "old search" },
        {
          role: "assistant",
          content: "",
          provider_continuation: {
            protocol: "openai_responses",
            toolCallIds: ["call-old"],
            anchorCallId: "call-old",
            reasoningItems: [{ type: "reasoning", id: "rs-old", encrypted_content: "old" }],
          },
          tool_calls: [{ id: "call-old", type: "function", function: { name: "search", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call-old", content: "old result" },
        { role: "user", content: "search" },
        {
          role: "assistant",
          content: "",
          provider_continuation: result.providerContinuation!,
          tool_calls: result.toolCalls!,
        },
        { role: "tool", tool_call_id: "call-r", content: "result" },
      ],
      model: "gpt-5",
      provider: { key: "openai", name: "OpenAI", provider_type: "openai_resp", api_key: "test" },
    });
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { input: Array<{ type: string }> };
    expect(secondBody.input.map((item) => item.type)).toEqual([
      "message",
      "function_call",
      "function_call_output",
      "message",
      "reasoning",
      "function_call",
      "function_call_output",
    ]);
    expect(secondBody.input.filter((item) => item.type === "reasoning")).toHaveLength(1);
  });

  it("carries Responses reasoning across consecutive tool calls and preserves its original anchor", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        status: "completed",
        output: [
          { type: "reasoning", id: "rs-chain", encrypted_content: "opaque-chain", summary: [] },
          { type: "function_call", call_id: "call-1", name: "first", arguments: "{}" },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        status: "completed",
        output: [{ type: "function_call", call_id: "call-2", name: "second", arguments: "{}" }],
      }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed", output_text: "done" }));
    const client = new OpenAiCompatibleClient();
    const provider = { key: "openai", name: "OpenAI", provider_type: "openai_resp", api_key: "test" };
    const first = await client.complete({ messages: [{ role: "user", content: "start" }], model: "gpt-5", provider });
    const firstAssistant = {
      role: "assistant" as const,
      content: "",
      provider_continuation: first.providerContinuation!,
      tool_calls: first.toolCalls!,
    };
    const second = await client.complete({
      messages: [
        { role: "user", content: "start" },
        firstAssistant,
        { role: "tool", tool_call_id: "call-1", content: "first result" },
      ],
      model: "gpt-5",
      provider,
    });
    expect(second.providerContinuation).toEqual({
      protocol: "openai_responses",
      toolCallIds: ["call-2"],
      anchorCallId: "call-1",
      reasoningItems: [{ type: "reasoning", id: "rs-chain", encrypted_content: "opaque-chain", summary: [] }],
    });

    await client.complete({
      messages: [
        { role: "user", content: "start" },
        firstAssistant,
        { role: "tool", tool_call_id: "call-1", content: "first result" },
        {
          role: "assistant",
          content: "",
          provider_continuation: second.providerContinuation!,
          tool_calls: second.toolCalls!,
        },
        { role: "tool", tool_call_id: "call-2", content: "second result" },
      ],
      model: "gpt-5",
      provider,
    });
    const thirdBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as { input: Array<{ type: string }> };
    expect(thirdBody.input.map((item) => item.type)).toEqual([
      "message",
      "reasoning",
      "function_call",
      "function_call_output",
      "function_call",
      "function_call_output",
    ]);
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

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function anthropicEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function responseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
