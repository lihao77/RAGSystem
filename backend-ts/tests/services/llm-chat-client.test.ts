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
});

function buildRequest(): ChatCompletionRequest {
  return {
    messages: [{ role: "user", content: "hello" }],
    model: "deepseek-chat",
    provider: {
      key: "my_deepseek",
      name: "my",
      provider_type: "deepseek",
      api_key: "sk-test",
      models: ["deepseek-chat"],
      model_map: {
        chat: "deepseek-chat",
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
