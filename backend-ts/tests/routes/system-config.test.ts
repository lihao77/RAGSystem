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
    expect(schema.json()).toMatchObject({
      success: true,
      message: "系统配置 schema",
      data: {
        groups: expect.arrayContaining([
          expect.objectContaining({
            key: "vector_store.sqlite_vec",
            label: "SQLite 向量存储",
          }),
        ]),
      },
    });

    expect(schema.json().data.groups.map((group: { key: string }) => group.key)).not.toEqual(
      expect.arrayContaining(["llm", "embedding", "waiting", "reflection"]),
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
        vector_store: {
          backend: "sqlite_vec",
          sqlite_vec: {
            distance_metric: "cosine",
          },
        },
      },
    });
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
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      success: true,
      message: "系统配置已更新",
      data: {
        vector_store: {
          backend: "sqlite_vec",
          sqlite_vec: {
            distance_metric: "l2",
            vector_dimension: 0,
          },
        },
      },
    });
    expect(updated.json().data).not.toHaveProperty("llm");

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
    expect(config.json().data.vector_store.sqlite_vec.distance_metric).toBe("cosine");
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
