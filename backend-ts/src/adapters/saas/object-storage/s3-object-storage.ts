import type { ObjectMetadata, ObjectStorage } from "../../../contracts/object-storage.js";

export interface S3ObjectTransport {
  putObject(input: { bucket: string; key: string; body: Uint8Array; contentType: string | null }): Promise<{ etag?: string | null }>;
  getObject(input: { bucket: string; key: string }): Promise<{ body: Uint8Array; contentType?: string | null; etag?: string | null } | null>;
  headObject(input: { bucket: string; key: string }): Promise<{ contentLength: number; contentType?: string | null; etag?: string | null } | null>;
  deleteObject(input: { bucket: string; key: string }): Promise<boolean>;
}

/** S3-compatible adapter. AWS/MinIO SDK wiring stays in the composition root. */
export class S3ObjectStorage implements ObjectStorage {
  constructor(private readonly transport: S3ObjectTransport, private readonly bucket: string) {}

  async put(key: string, body: Uint8Array, contentType: string | null = null): Promise<ObjectMetadata> {
    const result = await this.transport.putObject({ bucket: this.bucket, key, body, contentType });
    return { key, contentType, contentLength: body.byteLength, etag: result.etag ?? null };
  }

  async get(key: string): Promise<{ body: Uint8Array; metadata: ObjectMetadata } | null> {
    const result = await this.transport.getObject({ bucket: this.bucket, key });
    return result ? { body: result.body, metadata: { key, contentType: result.contentType ?? null, contentLength: result.body.byteLength, etag: result.etag ?? null } } : null;
  }

  async head(key: string): Promise<ObjectMetadata | null> {
    const result = await this.transport.headObject({ bucket: this.bucket, key });
    return result ? { key, contentType: result.contentType ?? null, contentLength: result.contentLength, etag: result.etag ?? null } : null;
  }

  delete(key: string): Promise<boolean> { return this.transport.deleteObject({ bucket: this.bucket, key }); }
}
