import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ObjectMetadata, ObjectStorage } from "../../contracts/object-storage.js";

export class FilesystemObjectStorage implements ObjectStorage {
  constructor(private readonly root: string) {}

  async put(key: string, body: Uint8Array, contentType: string | null = null): Promise<ObjectMetadata> {
    const filePath = this.resolve(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, body);
    return this.metadata(key, body.byteLength, contentType, hash(body));
  }

  async get(key: string): Promise<{ body: Uint8Array; metadata: ObjectMetadata } | null> {
    try {
      const body = await fs.readFile(this.resolve(key));
      return { body, metadata: this.metadata(key, body.byteLength, null, hash(body)) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async head(key: string): Promise<ObjectMetadata | null> {
    try {
      const stat = await fs.stat(this.resolve(key));
      return this.metadata(key, stat.size, null, null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<boolean> {
    try { await fs.unlink(this.resolve(key)); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private resolve(key: string): string {
    const normalized = key.replaceAll("\\", "/").replace(/^\/+/, "");
    const resolved = path.resolve(this.root, normalized);
    const root = path.resolve(this.root);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("object key escapes storage root");
    return resolved;
  }

  private metadata(key: string, contentLength: number, contentType: string | null, etag: string | null): ObjectMetadata {
    return { key, contentType, contentLength, etag };
  }
}

function hash(body: Uint8Array): string { return createHash("sha256").update(body).digest("hex"); }
