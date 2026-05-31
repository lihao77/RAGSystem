import { randomUUID } from "node:crypto";

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

describe("file management compatibility routes", () => {
  it("uploads, lists, filters, downloads, validates, and deletes global files", async () => {
    app = await buildTestApp();

    const uploaded = await app.inject({
      method: "POST",
      url: "/api/files/upload",
      headers: multipartHeaders("boundary-global"),
      payload: multipartBody("boundary-global", "files", "notes.txt", "text/plain", "hello file"),
    });
    expect(uploaded.statusCode).toBe(200);
    const file = uploaded.json().files[0];
    expect(file).toMatchObject({
      original_name: "notes.txt",
      mime: "text/plain",
      size: 10,
      indexed_in_vector: false,
      scope_type: "global",
      scope_id: null,
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/files",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().files.map((item: { id: string }) => item.id)).toContain(file.id);

    const filtered = await app.inject({
      method: "GET",
      url: "/api/files?extensions=.txt&mime_types=application/pdf",
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().files).toHaveLength(1);
    expect(filtered.json().files[0].id).toBe(file.id);

    const valid = await app.inject({
      method: "POST",
      url: "/api/files/validate",
      payload: {
        file_ids: [file.id, "missing"],
      },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({
      success: true,
      valid: [file.id],
      invalid: ["missing"],
    });

    const download = await app.inject({
      method: "GET",
      url: `/api/files/${file.id}/download`,
    });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("hello file");
    expect(download.headers["content-disposition"]).toContain('filename="notes.txt"');

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/files/${file.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ success: true });

    const missing = await app.inject({
      method: "GET",
      url: `/api/files/${file.id}`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("keeps session files scoped to their session", async () => {
    app = await buildTestApp();
    const sessionId = `session-${randomUUID()}`;

    const uploaded = await app.inject({
      method: "POST",
      url: `/api/agent/sessions/${encodeURIComponent(sessionId)}/files/upload`,
      headers: multipartHeaders("boundary-session"),
      payload: multipartBody("boundary-session", "files", "session.csv", "text/csv", "a,b\n1,2\n"),
    });
    expect(uploaded.statusCode).toBe(200);
    const file = uploaded.json().files[0];
    expect(file).toMatchObject({
      original_name: "session.csv",
      scope_type: "session",
      scope_id: sessionId,
    });

    const globalList = await app.inject({
      method: "GET",
      url: "/api/files",
    });
    expect(globalList.json().files.map((item: { id: string }) => item.id)).not.toContain(file.id);

    const sessionList = await app.inject({
      method: "GET",
      url: `/api/agent/sessions/${encodeURIComponent(sessionId)}/files`,
    });
    expect(sessionList.statusCode).toBe(200);
    expect(sessionList.json().files.map((item: { id: string }) => item.id)).toContain(file.id);

    const validate = await app.inject({
      method: "POST",
      url: `/api/agent/sessions/${encodeURIComponent(sessionId)}/files/validate`,
      payload: {
        file_ids: [file.id, "missing"],
      },
    });
    expect(validate.statusCode).toBe(200);
    expect(validate.json()).toEqual({
      success: true,
      valid: [file.id],
      invalid: ["missing"],
    });

    const download = await app.inject({
      method: "GET",
      url: `/api/agent/sessions/${encodeURIComponent(sessionId)}/files/${file.id}/download`,
    });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("a,b\n1,2\n");

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/agent/sessions/${encodeURIComponent(sessionId)}/files/${file.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ success: true });
  });

  it("validates missing files and malformed uploads", async () => {
    app = await buildTestApp();

    const missing = await app.inject({
      method: "DELETE",
      url: "/api/files/missing",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      success: false,
      code: "not_found",
      message: "文件不存在",
    });

    const notMultipart = await app.inject({
      method: "POST",
      url: "/api/files/upload",
      payload: {
        files: [],
      },
    });
    expect(notMultipart.statusCode).toBe(400);
    expect(notMultipart.json()).toMatchObject({
      success: false,
      code: "invalid_request",
      message: "请求必须使用 multipart/form-data",
    });
  });
});

function multipartHeaders(boundary: string): Record<string, string> {
  return {
    "content-type": `multipart/form-data; boundary=${boundary}`,
  };
}

function multipartBody(
  boundary: string,
  fieldName: string,
  filename: string,
  contentType: string,
  content: string,
): string {
  return [
    `--${boundary}`,
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"`,
    `Content-Type: ${contentType}`,
    "",
    content,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}
