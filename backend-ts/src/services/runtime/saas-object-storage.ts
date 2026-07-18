import type { ObjectStorage } from "../../contracts/object-storage.js";
import { S3ObjectStorage, type S3ObjectTransport } from "../../adapters/saas/object-storage/s3-object-storage.js";

export interface SaaSObjectStorageConfig {
  mode: "s3";
  bucket: string;
  endpoint?: string;
}

/**
 * Composition boundary for SaaS blob storage. The SDK/client transport belongs
 * to the process composition root; the domain adapter remains dependency-free.
 */
export function createSaaSObjectStorage(
  config: SaaSObjectStorageConfig,
  transport?: S3ObjectTransport,
): ObjectStorage {
  if (config.mode !== "s3") throw new Error("SaaS object storage only supports mode=s3");
  const bucket = config.bucket.trim();
  if (!bucket) throw new Error("SaaS object storage requires a bucket");
  if (!transport) {
    throw new Error(
      "SaaS object storage transport is not configured; inject an S3-compatible transport (AWS/MinIO) in the composition root",
    );
  }
  return new S3ObjectStorage(transport, bucket);
}
