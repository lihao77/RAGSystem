import { timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";

import type { SandboxServiceConfig } from "./config.js";
import { DockerCommandError, DockerSandboxEngine } from "./docker-cli.js";
import { SandboxCapacityError, SandboxLeaseStore, SandboxNotFoundError } from "./lease-store.js";
import type { SandboxOwner } from "./types.js";

export interface SandboxHttpServer {
  listen(): Promise<void>;
  close(): Promise<void>;
}

export function createSandboxHttpServer(
  config: SandboxServiceConfig,
  engine: DockerSandboxEngine,
  leases: SandboxLeaseStore,
): SandboxHttpServer {
  const server = http.createServer((request, response) => {
    void handleRequest(config, engine, leases, request, response).catch((error) => {
      sendError(response, error);
    });
  });
  server.requestTimeout = 650_000;
  server.headersTimeout = 30_000;

  return {
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        resolve();
      });
    }),
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function handleRequest(
  config: SandboxServiceConfig,
  engine: DockerSandboxEngine,
  leases: SandboxLeaseStore,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://sandbox.local");
  if (method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
    sendJson(response, 200, { status: "ok" });
    return;
  }
  requireBearer(request, config.apiToken);

  if (method === "POST" && url.pathname === "/v1/sandboxes") {
    const body = requireRecord(await readJson(request, config.maxRequestBytes), "create request");
    const owner = requireOwner(body.owner);
    if (body.network !== "none") throw new HttpError(400, "invalid_network", "Sandbox network must be none");
    const filesystem = requireRecord(body.filesystem, "filesystem");
    if (filesystem.input !== "read_only" || filesystem.work !== "read_write" || filesystem.output !== undefined) {
      throw new HttpError(400, "invalid_filesystem", "Sandbox filesystem policy is not supported");
    }
    const timeoutSeconds = requireInteger(body.timeoutSeconds, "timeoutSeconds", 1, 3_600);
    const lease = await leases.create(owner, timeoutSeconds);
    sendJson(response, 201, {
      id: lease.id,
      owner: lease.owner,
      createdAt: lease.createdAt,
      expiresAt: lease.expiresAt,
    });
    return;
  }

  const match = /^\/v1\/sandboxes\/([a-f0-9]{32})(?:\/(.+))?$/.exec(url.pathname);
  if (!match) throw new HttpError(404, "not_found", "Route not found");
  const sandboxId = match[1]!;
  const action = match[2] ?? "";
  if (method === "DELETE" && !action) {
    await leases.destroy(sandboxId);
    response.writeHead(204).end();
    return;
  }
  const lease = leases.require(sandboxId);
  const body = method === "POST" ? await readJson(request, config.maxRequestBytes) : null;

  if (method === "POST" && action === "files/stage-input") {
    sendJson(response, 200, await engine.stageInput(lease, body));
    return;
  }
  const fileOperation = FILE_OPERATIONS.get(action);
  if (method === "POST" && fileOperation) {
    sendJson(response, 200, await engine.fileOperation(lease, fileOperation, body));
    return;
  }
  if (method === "POST" && action === "exec") {
    sendJson(response, 200, await engine.execute(lease, "bash", body));
    return;
  }
  if (method === "POST" && action === "code") {
    sendJson(response, 200, await engine.execute(lease, "code", body));
    return;
  }
  throw new HttpError(404, "not_found", "Route not found");
}

const FILE_OPERATIONS = new Map<string, string>([
  ["files/read", "read"],
  ["files/write", "write"],
  ["files/edit", "edit"],
  ["files/glob", "glob"],
  ["files/grep", "grep"],
  ["files/preview", "preview"],
]);

function requireBearer(request: IncomingMessage, expected: string): void {
  const authorization = request.headers.authorization;
  const actual = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  if (actualBytes.byteLength !== expectedBytes.byteLength || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new HttpError(401, "unauthorized", "Invalid sandbox service token");
  }
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    size += chunk.byteLength;
    if (size > maxBytes) throw new HttpError(413, "request_too_large", "Sandbox request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
  }
}

function requireOwner(value: unknown): SandboxOwner {
  const owner = requireRecord(value, "owner");
  return {
    tenantId: requireIdentity(owner.tenantId, "tenantId"),
    userId: requireIdentity(owner.userId, "userId"),
    sessionId: requireIdentity(owner.sessionId, "sessionId"),
    runId: requireIdentity(owner.runId, "runId"),
  };
}

function requireIdentity(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\0\r\n]/.test(value)) {
    throw new HttpError(400, "invalid_owner", `Invalid sandbox owner ${name}`);
  }
  return value.trim();
}

function requireInteger(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new HttpError(400, "invalid_request", `${name} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (error instanceof HttpError) {
    sendJson(response, error.status, { code: error.code, message: error.message });
    return;
  }
  if (error instanceof SandboxNotFoundError) {
    sendJson(response, 404, { code: "sandbox_not_found", message: error.message });
    return;
  }
  if (error instanceof SandboxCapacityError) {
    sendJson(response, 503, { code: "sandbox_capacity_exhausted", message: error.message });
    return;
  }
  if (error instanceof DockerCommandError) {
    console.error(JSON.stringify({ event: "docker_command_failed", command: error.command, stderr: error.result.stderr }));
    sendJson(response, 502, { code: "sandbox_runtime_error", message: "Sandbox runtime operation failed" });
    return;
  }
  console.error(error);
  sendJson(response, 500, { code: "internal_error", message: "Sandbox service internal error" });
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "HttpError";
  }
}
