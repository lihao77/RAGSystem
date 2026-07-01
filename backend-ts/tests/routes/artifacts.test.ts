import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildTestApp, testDataRoot } from "../helpers/app.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe("artifact compatibility routes", () => {
  it("reads Python-compatible visualization config and session index entries", async () => {
    app = await buildTestApp();
    const fixture = createVisualizationFixture("artifact-session", "viz_test_chart");

    const config = await app.inject({
      method: "GET",
      url: "/api/artifacts/visualizations/viz_test_chart",
    });
    expect(config.statusCode).toBe(200);
    expect(config.json()).toEqual({
      artifact_id: "viz_test_chart",
      viz_type: "chart",
      sub_type: "line",
      title: "测试图表",
      version: 1,
      config: {
        xAxis: { type: "category", data: ["A", "B"] },
        series: [{ type: "line", data: [1, 2] }],
      },
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/artifacts/visualizations?session_id=artifact-session",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([
      {
        artifact_id: "viz_test_chart",
        viz_type: "chart",
        sub_type: "line",
        title: "测试图表",
        version: 1,
        created_at: fixture.createdAt,
        updated_at: fixture.createdAt,
      },
    ]);
  });

  it("returns image visualization metadata without reading image bytes", async () => {
    app = await buildTestApp();
    const fixture = createImageFixture("image-session", "viz_test_image");

    const response = await app.inject({
      method: "GET",
      url: "/api/artifacts/visualizations/viz_test_image",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      artifact_id: "viz_test_image",
      viz_type: "image",
      sub_type: "png",
      title: "测试图片",
      version: 1,
      image_url: fixture.imagePath,
    });
  });

  it("deletes one visualization and rewrites the session index", async () => {
    app = await buildTestApp();
    const first = createVisualizationFixture("delete-session", "viz_delete_one");
    const second = createVisualizationFixture("delete-session", "viz_keep_one");

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/artifacts/visualizations/viz_delete_one",
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({
      deleted: true,
      artifact_id: "viz_delete_one",
    });
    expect(fs.existsSync(first.filePath)).toBe(false);
    expect(fs.existsSync(second.filePath)).toBe(true);

    const listed = await app.inject({
      method: "GET",
      url: "/api/artifacts/visualizations?session_id=delete-session",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().map((item: { artifact_id: string }) => item.artifact_id)).toEqual(["viz_keep_one"]);
  });

  it("deletes all visualizations for a session", async () => {
    app = await buildTestApp();
    const first = createVisualizationFixture("delete-all-session", "viz_delete_all_1");
    const second = createImageFixture("delete-all-session", "viz_delete_all_2");

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/artifacts/visualizations?session_id=delete-all-session",
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({
      deleted_count: 2,
      session_id: "delete-all-session",
    });
    expect(fs.existsSync(first.filePath)).toBe(false);
    expect(fs.existsSync(second.imagePath)).toBe(false);

    const listed = await app.inject({
      method: "GET",
      url: "/api/artifacts/visualizations?session_id=delete-all-session",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([]);
  });

  it("validates missing visualization resources and session query", async () => {
    app = await buildTestApp();

    const missing = await app.inject({
      method: "GET",
      url: "/api/artifacts/visualizations/missing",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      success: false,
      code: "not_found",
      message: "未找到可视化 artifact: missing",
    });

    const missingSession = await app.inject({
      method: "GET",
      url: "/api/artifacts/visualizations",
    });
    expect(missingSession.statusCode).toBe(400);
    expect(missingSession.json()).toMatchObject({
      success: false,
      code: "invalid_request",
      message: "session_id is required",
    });
  });
});

function createVisualizationFixture(sessionId: string, artifactId: string): { filePath: string; createdAt: number } {
  const createdAt = 1710000000;
  const root = visualizationRoot(sessionId);
  fs.mkdirSync(root, { recursive: true });
  const filePath = path.join(root, `${artifactId}.json`);
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      artifact_id: artifactId,
      viz_type: "chart",
      sub_type: "line",
      title: "测试图表",
      version: 1,
      config: {
        xAxis: { type: "category", data: ["A", "B"] },
        series: [{ type: "line", data: [1, 2] }],
      },
    }),
    "utf8",
  );
  appendIndexEntry(sessionId, {
    artifact_id: artifactId,
    viz_type: "chart",
    sub_type: "line",
    title: "测试图表",
    version: 1,
    file_path: filePath,
    artifact_type: "json",
    mime_type: "application/json",
    session_id: sessionId,
    created_at: createdAt,
    updated_at: createdAt,
  });
  return { filePath, createdAt };
}

function createImageFixture(sessionId: string, artifactId: string): { imagePath: string } {
  const root = visualizationRoot(sessionId);
  fs.mkdirSync(root, { recursive: true });
  const imagePath = path.join(root, `${artifactId}.png`);
  fs.writeFileSync(imagePath, "image-bytes", "utf8");
  appendIndexEntry(sessionId, {
    artifact_id: artifactId,
    viz_type: "image",
    sub_type: "png",
    title: "测试图片",
    version: 1,
    file_path: imagePath,
    artifact_type: "image",
    mime_type: "image/png",
    session_id: sessionId,
    created_at: 1710000001,
    updated_at: 1710000001,
  });
  return { imagePath };
}

function appendIndexEntry(sessionId: string, entry: Record<string, unknown>): void {
  const indexPath = path.join(visualizationRoot(sessionId), "viz_index.jsonl");
  fs.appendFileSync(indexPath, JSON.stringify(entry) + "\n", "utf8");
}

function visualizationRoot(sessionId: string): string {
  return path.resolve(testDataRoot, "sessions", sessionId, "visualizations");
}
