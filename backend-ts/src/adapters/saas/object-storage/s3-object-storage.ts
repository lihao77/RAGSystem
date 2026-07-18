import type { ObjectMetadata, ObjectStorage } from "../../../contracts/object-storage.js";
import { createHash, createHmac } from "node:crypto";

export interface S3ObjectTransport {
  putObject(input: { bucket: string; key: string; body: Uint8Array; contentType: string | null }): Promise<{ etag?: string | null }>;
  getObject(input: { bucket: string; key: string }): Promise<{ body: Uint8Array; contentType?: string | null; etag?: string | null } | null>;
  headObject(input: { bucket: string; key: string }): Promise<{ contentLength: number; contentType?: string | null; etag?: string | null } | null>;
  deleteObject(input: { bucket: string; key: string }): Promise<boolean>;
}

export interface S3HttpTransportConfig {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  forcePathStyle?: boolean;
}

/** Minimal AWS SigV4 transport compatible with AWS S3 and MinIO. */
export class S3HttpTransport implements S3ObjectTransport {
  private readonly endpoint: URL;
  private readonly region: string;
  private readonly pathStyle: boolean;
  constructor(private readonly config: S3HttpTransportConfig) {
    this.endpoint = new URL(config.endpoint);
    this.region = config.region ?? "us-east-1";
    this.pathStyle = config.forcePathStyle ?? true;
  }
  async putObject(input: { bucket: string; key: string; body: Uint8Array; contentType: string | null }) {
    const response = await this.request("PUT", input.bucket, input.key, input.body, input.contentType);
    return { etag: response.headers.get("etag") };
  }
  async getObject(input: { bucket: string; key: string }) {
    const response = await this.request("GET", input.bucket, input.key);
    if (response.status === 404) return null;
    if (!response.ok) throw await this.error(response);
    return { body: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type"), etag: response.headers.get("etag") };
  }
  async headObject(input: { bucket: string; key: string }) {
    const response = await this.request("HEAD", input.bucket, input.key);
    if (response.status === 404) return null;
    if (!response.ok) throw await this.error(response);
    return { contentLength: Number(response.headers.get("content-length") ?? 0), contentType: response.headers.get("content-type"), etag: response.headers.get("etag") };
  }
  async deleteObject(input: { bucket: string; key: string }) {
    const response = await this.request("DELETE", input.bucket, input.key);
    if (response.status === 404) return false;
    if (!response.ok) throw await this.error(response);
    return true;
  }
  private async request(method: string, bucket: string, key: string, body?: Uint8Array, contentType?: string | null): Promise<Response> {
    const encodedKey = key.split("/").map((part) => encodeURIComponent(part)).join("/");
    const path = this.pathStyle ? `/${encodeURIComponent(bucket)}/${encodedKey}` : `/${encodedKey}`;
    const host = this.pathStyle ? this.endpoint.host : `${bucket}.${this.endpoint.host}`;
    const url = new URL(path, this.endpoint);
    if (!this.pathStyle) url.hostname = `${bucket}.${this.endpoint.hostname}`;
    const payload = body ?? new Uint8Array();
    const payloadHash = sha256(payload);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const headers: Record<string, string> = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
    if (contentType) headers["content-type"] = contentType;
    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers).sort().map((k) => `${k}:${(headers[k] ?? "").trim()}\n`).join("");
    const canonicalRequest = [method, url.pathname, url.search.slice(1), canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
    const signingKey = hmacBytes(hmacBytes(hmacBytes(hmacBytes(`AWS4${this.config.secretAccessKey}`, date), this.region), "s3"), "aws4_request");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${hmac(signingKey, stringToSign)}`;
    return fetch(url, { method, headers, body: body as any });
  }
  private async error(response: Response): Promise<Error> { return new Error(`S3 request failed (${response.status}): ${await response.text().catch(() => "")}`); }
}
function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function hmac(key: string | Buffer, value: string): string { return createHmac("sha256", key).update(value).digest("hex"); }
function hmacBytes(key: string | Buffer, value: string): Buffer { return createHmac("sha256", key).update(value).digest(); }

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
