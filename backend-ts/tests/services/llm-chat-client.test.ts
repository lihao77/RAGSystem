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
