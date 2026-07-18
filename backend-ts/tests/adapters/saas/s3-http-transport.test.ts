import { describe, expect, it, vi } from "vitest";
import { S3HttpTransport } from "../../../src/adapters/saas/object-storage/s3-object-storage.js";

describe("S3HttpTransport", () => {
  it("signs path-style requests and handles object operations", async () => {
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(init.method).toBe("PUT");
      const headers = init.headers as Record<string, string>;
      expect(headers.authorization).toContain("AWS4-HMAC-SHA256 Credential=access/");
      expect(headers["x-amz-content-sha256"]).toMatch(/^[a-f0-9]{64}$/);
      return new Response(null, { status: 200, headers: { etag: "etag-1" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const transport = new S3HttpTransport({ endpoint: "http://minio:9000", accessKeyId: "access", secretAccessKey: "secret" });
    await expect(transport.putObject({ bucket: "bucket", key: "a/b.txt", body: new Uint8Array([1]), contentType: "text/plain" })).resolves.toEqual({ etag: "etag-1" });
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
