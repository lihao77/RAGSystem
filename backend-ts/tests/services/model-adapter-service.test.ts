import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { ModelAdapterService } from "../../src/services/integrations/model-adapter-service.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("ModelAdapterService provider file compatibility", () => {
  it("loads Python-compatible providers.yaml from the shared data root", () => {
    const dataRoot = makeTempDataRoot();
    const providersPath = writeProvidersYaml(dataRoot, {
      rag_deepseek: {
        name: "rag",
        provider_type: "deepseek",
        api_key: "sk-test",
        api_endpoint: "https://api.deepseek.com/v1",
        temperature: 0.2,
        max_completion_tokens: 4096,
        max_context_tokens: 128000,
        timeout: 60,
        model_map: {
          chat: ["deepseek-v4-pro", "deepseek-v4-flash"],
        },
        models: ["deepseek-v4-pro", "deepseek-v4-flash"],
      },
    });

    const service = new ModelAdapterService({ dataRoot });

    expect(providersPath).toBe(path.join(dataRoot, "config", "model_adapter", "providers.yaml"));
    expect(service.listProviders()).toEqual([
      expect.objectContaining({
        key: "rag_deepseek",
        name: "rag",
        provider_type: "deepseek",
        api_key: "sk-test",
        model_map: {
          chat: ["deepseek-v4-pro", "deepseek-v4-flash"],
        },
        models: ["deepseek-v4-pro", "deepseek-v4-flash"],
        is_loaded: true,
      }),
    ]);
  });

  it("persists create, reorder, update, and delete operations to the same providers.yaml", () => {
    const dataRoot = makeTempDataRoot();
    const service = new ModelAdapterService({ dataRoot });

    const providerKey = service.createProvider({
      name: "my",
      provider_type: "deepseek",
      api_key: "sk-test",
      model_map: {
        chat: "deepseek-chat",
      },
    });
    expect(providerKey).toBe("my_deepseek");
    expect(readProvidersYaml(dataRoot)).toMatchObject({
      my_deepseek: {
        name: "my",
        provider_type: "deepseek",
        api_key: "sk-test",
        model_map: {
          chat: "deepseek-chat",
        },
      },
    });

    service.createProvider({
      name: "aa",
      provider_type: "openai_chat",
      api_key: "sk-aa",
      model: "gpt-test",
    });
    service.reorderProviders({ provider_keys: ["aa_openai_chat", "my_deepseek"] });
    expect(Object.keys(readProvidersYaml(dataRoot))).toEqual(["aa_openai_chat", "my_deepseek"]);

    service.updateProvider("my_deepseek", {
      model_map: {
        chat: ["deepseek-chat", "deepseek-reasoner"],
      },
      temperature: 0.1,
    });
    expect(readProvidersYaml(dataRoot)).toMatchObject({
      my_deepseek: {
        temperature: 0.1,
        model_map: {
          chat: ["deepseek-chat", "deepseek-reasoner"],
        },
        models: ["deepseek-chat", "deepseek-reasoner"],
      },
    });

    service.deleteProvider("aa_openai_chat");
    expect(Object.keys(readProvidersYaml(dataRoot))).toEqual(["my_deepseek"]);
  });
});

function makeTempDataRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-backend-ts-"));
  tempRoots.push(root);
  return root;
}

function writeProvidersYaml(dataRoot: string, payload: Record<string, unknown>): string {
  const providersPath = path.join(dataRoot, "config", "model_adapter", "providers.yaml");
  fs.mkdirSync(path.dirname(providersPath), { recursive: true });
  fs.writeFileSync(providersPath, YAML.stringify(payload), "utf8");
  return providersPath;
}

function readProvidersYaml(dataRoot: string): Record<string, unknown> {
  const providersPath = path.join(dataRoot, "config", "model_adapter", "providers.yaml");
  const parsed = YAML.parse(fs.readFileSync(providersPath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("providers.yaml did not contain an object");
  }
  return parsed as Record<string, unknown>;
}
