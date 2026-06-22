import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentConfigSchema } from "../../src/contracts/agent-config.js";
import { OpenAiCompatibleChatClient } from "../../src/services/integrations/llm-chat-client.js";
import type { ChatCompletionRequest } from "../../src/services/integrations/llm-chat-client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("OpenAI-compatible chat client", () => {
  it("sends tool definitions and returns assistant tool calls for non-streaming requests", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "deepseek-chat",
        tools: [
          {
            type: "function",
            function: {
              name: "list_memory_index",
            },
          },
        ],
        tool_choice: "auto",
      });
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "list_memory_index",
                      arguments: "{\"scope\":\"session\"}",
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new OpenAiCompatibleChatClient();
    const result = await client.complete({
      ...buildRequest(),
      tools: [
        {
          type: "function",
          function: {
            name: "list_memory_index",
            description: "List memory index",
            parameters: {
              type: "object",
              properties: {
                scope: { type: "string" },
              },
            },
          },
        },
      ],
    });

    expect(result).toMatchObject({
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "list_memory_index",
            arguments: "{\"scope\":\"session\"}",
          },
        },
      ],
    });
  });

  it("streams OpenAI-compatible SSE chunks and returns the final content", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "deepseek-chat",
        stream: true,
      });
      return new Response(
        [
          'data: {"choices":[{"delta":{"content":"hello "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
          },
        },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new OpenAiCompatibleChatClient();
    const chunks: string[] = [];
    const result = await client.stream(buildRequest(), (chunk) => {
      chunks.push(chunk.content);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.deepseek.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer sk-test",
        }),
      }),
    );
    expect(chunks).toEqual(["hello ", "world"]);
    expect(result.content).toBe("hello world");
  });

  it("lets stream handlers stop OpenAI-compatible SSE consumption early", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        [
          'data: {"choices":[{"delta":{"content":"<tool_calls></tool_calls>"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"<final_answer>ignored</final_answer>"}}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
          },
        },
      ),
    ) as typeof fetch;

    const client = new OpenAiCompatibleChatClient();
    const chunks: string[] = [];
    const result = await client.stream(buildRequest(), (chunk) => {
      chunks.push(chunk.content);
      return { stop: true };
    });

    expect(chunks).toEqual(["<tool_calls></tool_calls>"]);
    expect(result.content).toBe("<tool_calls></tool_calls>");
  });

  it("returns interrupted finish reasons from OpenAI-compatible SSE streams", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        'data: {"choices":[{"delta":{},"finish_reason":"interrupted"}]}\n\n',
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
          },
        },
      ),
    ) as typeof fetch;

    const client = new OpenAiCompatibleChatClient();
    const result = await client.stream(buildRequest(), () => undefined);

    expect(result).toMatchObject({
      content: "",
      finishReason: "interrupted",
    });
  });

  it("rejects empty non-interrupted OpenAI-compatible SSE streams by default", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        [
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
          },
        },
      ),
    ) as typeof fetch;

    const client = new OpenAiCompatibleChatClient();

    await expect(client.stream(buildRequest(), () => undefined)).rejects.toThrow(
      "LLM streaming response did not include assistant content",
    );
  });

  it("treats reasoning-only OpenAI-compatible SSE streams as non-empty for thinking models", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        [
          'data: {"choices":[{"delta":{"reasoning_content":"thinking "}}]}\n\n',
          'data: {"choices":[{"delta":{"reasoning_content":"about it"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
          },
        },
      ),
    ) as typeof fetch;

    const client = new OpenAiCompatibleChatClient();
    const chunks: string[] = [];
    const result = await client.stream(buildRequest(), (chunk) => {
      chunks.push(chunk.content);
    });

    // 思维链不向前端 emit（chunks 保持空），但 result 携带 reasoning，不再被误判为空响应。
    expect(chunks).toEqual([]);
    expect(result.content).toBe("");
    expect(result.reasoning).toBe("thinking about it");
    expect(result.finishReason).toBe("stop");
  });

  it("treats reasoning-only non-streaming responses as non-empty for thinking models", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: null,
                reasoning_content: "internal reasoning",
              },
            },
          ],
        }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const client = new OpenAiCompatibleChatClient();
    const result = await client.complete(buildRequest());

    expect(result.content).toBe("");
    expect(result.reasoning).toBe("internal reasoning");
    expect(result.finishReason).toBe("stop");
  });

  it("allows empty OpenAI-compatible SSE streams when requested by the runtime", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        [
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
          },
        },
      ),
    ) as typeof fetch;

    const client = new OpenAiCompatibleChatClient();
    const chunks: string[] = [];
    const result = await client.stream({ ...buildRequest(), allowEmptyStream: true }, (chunk) => {
      chunks.push(chunk.content);
    });

    expect(chunks).toEqual([]);
    expect(result).toMatchObject({
      content: "",
      finishReason: "stop",
    });
  });

  it("surfaces JSON error messages for failed streaming requests", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "bad api key" } }), { status: 401 }),
    ) as typeof fetch;

    const client = new OpenAiCompatibleChatClient();
    await expect(client.stream(buildRequest(), () => undefined)).rejects.toThrow("bad api key");
  });

  it("calls OpenAI Responses for openai_resp providers", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "gpt-4.1",
        instructions: expect.stringContaining("system"),
        input: [{ role: "user", content: "hello" }],
        max_output_tokens: 500,
      });
      return new Response(
        JSON.stringify({
          status: "completed",
          output_text: "response answer",
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new OpenAiCompatibleChatClient();
    const result = await client.complete({
      ...buildRequest({
        provider_type: "openai_resp",
        model: "gpt-4.1",
      }),
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "hello" },
      ],
      maxCompletionTokens: 500,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer sk-test" }),
      }),
    );
    expect(result).toMatchObject({
      content: "response answer",
      finishReason: "completed",
    });
  });

  it("calls Anthropic messages for anthropic providers", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "claude-sonnet-4-5",
        system: [{ type: "text", text: "system" }],
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        max_tokens: 500,
      });
      return new Response(
        JSON.stringify({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "claude answer" }],
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new OpenAiCompatibleChatClient();
    const result = await client.complete({
      ...buildRequest({
        provider_type: "anthropic",
        model: "claude-sonnet-4-5",
      }),
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "hello" },
      ],
      maxCompletionTokens: 500,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-api-key": "sk-test",
          "anthropic-version": "2023-06-01",
        }),
      }),
    );
    expect(result).toMatchObject({
      content: "claude answer",
      finishReason: "end_turn",
    });
  });

  it("converts OpenAI-style tools to Anthropic tools for native function calling", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        tools: [
          {
            name: "list_memory_index",
            description: "List memory index",
            input_schema: {
              type: "object",
              properties: { scope: { type: "string" } },
            },
          },
        ],
        tool_choice: { type: "auto" },
      });
      return new Response(
        JSON.stringify({
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "list_memory_index",
              input: { scope: "session" },
            },
          ],
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new OpenAiCompatibleChatClient();
    const result = await client.complete({
      ...buildRequest({
        provider_type: "anthropic",
        model: "claude-sonnet-4-5",
      }),
      tools: [
        {
          type: "function",
          function: {
            name: "list_memory_index",
            description: "List memory index",
            parameters: {
              type: "object",
              properties: { scope: { type: "string" } },
            },
          },
        },
      ],
    });

    expect(result).toMatchObject({
      finishReason: "tool_use",
      toolCalls: [
        {
          id: "toolu_1",
          type: "function",
          function: {
            name: "list_memory_index",
            arguments: "{\"scope\":\"session\"}",
          },
        },
      ],
    });
  });

  it("maps assistant tool_calls and tool results to Anthropic blocks", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: unknown }> };
      const assistant = body.messages.find((message) => message.role === "assistant");
      expect(assistant).toEqual({
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "list_memory_index",
            input: { scope: "session" },
          },
        ],
      });
      const userToolResult = body.messages.find(
        (message) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          (message.content as Array<{ type?: string }>)[0]?.type === "tool_result",
      );
      expect(userToolResult).toEqual({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "ok",
          },
        ],
      });
      return new Response(
        JSON.stringify({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "done" }],
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new OpenAiCompatibleChatClient();
    await client.complete({
      ...buildRequest({
        provider_type: "anthropic",
        model: "claude-sonnet-4-5",
      }),
      messages: [
        { role: "user", content: "check" },
        {
          role: "assistant",
          content: "Let me check.",
          tool_calls: [
            {
              id: "toolu_1",
              type: "function",
              function: {
                name: "list_memory_index",
                arguments: "{\"scope\":\"session\"}",
              },
            },
          ],
        },
        {
          role: "tool",
          content: "ok",
          tool_call_id: "toolu_1",
        },
      ],
    });
  });

  it("omits tool_choice when no tools are provided for anthropic providers", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      return new Response(
        JSON.stringify({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "ok" }],
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new OpenAiCompatibleChatClient();
    await client.complete({
      ...buildRequest({
        provider_type: "anthropic",
        model: "claude-sonnet-4-5",
      }),
    });
  });

  it("merges extra_params into chat completion body without overriding explicit fields", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.top_p).toBe(0.9);
      expect(body.frequency_penalty).toBe(0.1);
      // 显式字段不被 extra 覆盖
      expect(body.temperature).toBe(0.7);
      expect(body.model).toBe("deepseek-chat");
      expect(body.max_tokens).toBe(512);
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new OpenAiCompatibleChatClient();
    await client.complete({
      ...buildRequest(),
      temperature: 0.7,
      maxCompletionTokens: 512,
      extraParams: { top_p: 0.9, frequency_penalty: 0.1, temperature: 0.99, model: "evil", max_tokens: 9999 },
    });
  });

  it("merges extra_params into OpenAI Responses body", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.top_p).toBe(0.9);
      return new Response(JSON.stringify({ status: "completed", output_text: "ok" }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new OpenAiCompatibleChatClient();
    await client.complete({
      ...buildRequest({ provider_type: "openai_resp", model: "gpt-4.1" }),
      extraParams: { top_p: 0.9 },
    });
  });

  it("merges extra_params into Anthropic body without overriding explicit fields", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.top_p).toBe(0.9);
      expect(body.max_tokens).toBe(500);
      return new Response(
        JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new OpenAiCompatibleChatClient();
    await client.complete({
      ...buildRequest({ provider_type: "anthropic", model: "claude-sonnet-4-5" }),
      maxCompletionTokens: 500,
      extraParams: { top_p: 0.9, max_tokens: 9999 },
    });
  });
});

function buildRequest(input: { provider_type?: string; model?: string } = {}): ChatCompletionRequest {
  const providerType = input.provider_type ?? "deepseek";
  const model = input.model ?? "deepseek-chat";
  return {
    messages: [{ role: "user", content: "hello" }],
    model,
    provider: {
      key: `my_${providerType}`,
      name: "my",
      provider_type: providerType,
      api_key: "sk-test",
      models: [model],
      model_map: {
        chat: model,
      },
    },
    agent: AgentConfigSchema.parse({
      agent_name: "orchestrator_agent",
      display_name: "Orchestrator Agent",
      enabled: true,
      default_entry: true,
      llm_tiers: {},
      custom_params: {},
    }),
  };
}
