export interface ObjectMetadata {
  key: string;
  contentType: string | null;
  contentLength: number;
  etag: string | null;
}

export interface ObjectStorage {
  put(key: string, body: Uint8Array, contentType?: string | null): Promise<ObjectMetadata>;
  get(key: string): Promise<{ body: Uint8Array; metadata: ObjectMetadata } | null>;
  head(key: string): Promise<ObjectMetadata | null>;
  delete(key: string): Promise<boolean>;
}
