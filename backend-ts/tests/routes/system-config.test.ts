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

describe("system config compatibility routes", () => {
  it("serves schema and default config for the schema form", async () => {
    app = await buildTestApp();

    const schema = await app.inject({
      method: "GET",
      url: "/api/system-config/schema",
    });
    expect(schema.statusCode).toBe(200);
    expect(schema.json()).toMatchObject({ success: true, message: "系统配置 schema" });
    const groupKeys = schema.json().data.groups.map((group: { key: string }) => group.key);
    expect(groupKeys).toEqual(expect.arrayContaining(["document_extraction", "system", "memory", "tools", "context"]));
    for (const removedGroup of ["vector_store.sqlite_vec", "llm", "embedding", "waiting", "reflection"]) {
      expect(groupKeys).not.toContain(removedGroup);
    }
    const cliGroup = schema.json().data.groups.find(
      (group: { key: string }) => group.key === "document_extraction.cli",
    );
    expect(cliGroup.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "applies_to", type: "string_list", default: [] }),
      ]),
    );

    const config = await app.inject({
      method: "GET",
      url: "/api/system-config",
    });
    expect(config.statusCode).toBe(200);
    expect(config.json()).toMatchObject({
      success: true,
      message: "当前系统配置",
      data: {
        document_extraction: { engine: "builtin" },
        memory: { index_max_lines: 200 },
      },
    });
    expect(config.json().data).not.toHaveProperty("vector_store");
  });

  it("deep-merges updates in memory and supports reload to defaults", async () => {
    app = await buildTestApp();

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/system-config",
      payload: {
        llm: { model_name: "legacy-model" },
        vector_store: {
          sqlite_vec: {
            distance_metric: "l2",
          },
        },
        memory: { index_max_lines: 42 },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      success: true,
      message: "系统配置已更新",
      data: {
        memory: { index_max_lines: 42, index_max_chars: 25600 },
      },
    });
    expect(updated.json().data).not.toHaveProperty("llm");
    expect(updated.json().data).not.toHaveProperty("vector_store");

    const reloaded = await app.inject({
      method: "POST",
      url: "/api/system-config/reload",
    });
    expect(reloaded.statusCode).toBe(200);
    expect(reloaded.json()).toEqual({
      success: true,
      message: "系统配置已重新加载",
    });

    const config = await app.inject({
      method: "GET",
      url: "/api/system-config",
    });
    expect(config.json().data).not.toHaveProperty("llm");
    expect(config.json().data).not.toHaveProperty("vector_store");
    expect(config.json().data.memory.index_max_lines).toBe(200);
  });

  it("rejects non-object update payloads", async () => {
    app = await buildTestApp();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/system-config",
      payload: ["not", "object"],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
    });
  });
});
