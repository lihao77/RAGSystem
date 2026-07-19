import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { FilesystemObjectStorage } from "../../src/adapters/local/filesystem-object-storage.js";
import { S3ObjectStorage } from "../../src/adapters/saas/object-storage/s3-object-storage.js";
import { createSaaSObjectStorage } from "../../src/app/composition/saas/saas-object-storage.js";

describe("ObjectStorage adapters", () => {
  it("keeps filesystem objects tenant-key scoped and blocks traversal", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ragsystem-objects-"));
    const storage = new FilesystemObjectStorage(root);
    await storage.put("tenant-1/file.txt", new TextEncoder().encode("hello"), "text/plain");
    expect(new TextDecoder().decode((await storage.get("tenant-1/file.txt"))!.body)).toBe("hello");
    await expect(storage.put("../../escape", new Uint8Array([1]))).rejects.toThrow("escapes storage root");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("maps an S3-compatible transport to the shared port", async () => {
    const calls: string[] = [];
    const storage = new S3ObjectStorage({
      putObject: async ({ key }) => { calls.push(`put:${key}`); return { etag: "e" }; },
      getObject: async ({ key }) => ({ body: new Uint8Array([1]), contentType: "x", etag: "e" }),
      headObject: async ({ key }) => ({ contentLength: 1, contentType: "x", etag: "e" }),
      deleteObject: async ({ key }) => { calls.push(`delete:${key}`); return true; },
    }, "bucket");
    expect((await storage.put("k", new Uint8Array([1]))).etag).toBe("e");
    expect((await storage.get("k"))?.metadata.contentLength).toBe(1);
    expect(await storage.delete("k")).toBe(true);
    expect(calls).toEqual(["put:k", "delete:k"]);
  });

  it("requires an injected transport at the SaaS composition boundary", () => {
    expect(() => createSaaSObjectStorage({ mode: "s3", bucket: "bucket" })).toThrow(
      "inject an S3-compatible transport",
    );
  });
});
