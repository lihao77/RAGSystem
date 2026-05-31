import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildTestApp } from "../helpers/app.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe("runtime core readiness routes", () => {
  it("separates missing runtime-core configuration from the execution runtime boundary", async () => {
    app = await buildTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/agent/runtime-core/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        kind: "runtime_core",
        status: "configuration_missing",
        configuration_ready: false,
        execution_runtime_migrated: false,
        can_execute: false,
        agent: {
          agent_name: "orchestrator_agent",
          source: "agent_config",
          enabled: true,
        },
        llm: {
          provider: "my",
          provider_type: "deepseek",
          model_name: "deepseek-chat",
          source: "agent_config.default",
        },
        provider: {
          configured: false,
          model_available: false,
          api_key_configured: false,
        },
      },
    });
    expect(response.json().data.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "model_provider_config",
          satisfied: false,
          code: "missing_provider_config",
        }),
        expect.objectContaining({
          key: "agent_runtime",
          category: "execution_runtime",
          satisfied: false,
          code: "not_migrated",
        }),
      ]),
    );
  });

  it("reports configuration-ready when agent, LLM, and provider config are present", async () => {
    app = await buildTestApp();

    const provider = await app.inject({
      method: "POST",
      url: "/api/model-adapter/providers",
      payload: {
        name: "my",
        provider_type: "deepseek",
        api_key: "sk-test",
        model_map: {
          chat: "deepseek-chat",
        },
      },
    });
    expect(provider.statusCode).toBe(200);

    const response = await app.inject({
      method: "GET",
      url: "/api/agent/runtime-core/status?agent_name=general_agent",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        status: "runtime_not_migrated",
        configuration_ready: true,
        execution_runtime_migrated: false,
        can_execute: false,
        agent: {
          agent_name: "general_agent",
        },
        provider: {
          configured: true,
          provider_key: "my_deepseek",
          model_available: true,
          api_key_configured: true,
        },
      },
    });
    const failedRequirements = response.json().data.requirements.filter(
      (item: { satisfied: boolean }) => !item.satisfied,
    );
    expect(failedRequirements).toEqual([
      expect.objectContaining({
        key: "agent_runtime",
        code: "not_migrated",
      }),
    ]);
  });

  it("supports frontend selectedLLM override parsing for runtime-core preflight", async () => {
    app = await buildTestApp();

    const provider = await app.inject({
      method: "POST",
      url: "/api/model-adapter/providers",
      payload: {
        name: "main",
        provider_type: "openai",
        api_mode: "responses",
        api_key: "sk-test",
        model: "gpt-4.1",
      },
    });
    expect(provider.statusCode).toBe(200);

    const response = await app.inject({
      method: "GET",
      url: "/api/agent/runtime-core/status?selectedLLM=main_openai_resp%7Copenai_resp%7Cgpt-4.1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        configuration_ready: true,
        llm: {
          provider: "main_openai_resp",
          provider_type: "openai_resp",
          model_name: "gpt-4.1",
          source: "selected_llm",
        },
        provider: {
          provider_key: "main_openai_resp",
          model_available: true,
        },
      },
    });
  });
});
