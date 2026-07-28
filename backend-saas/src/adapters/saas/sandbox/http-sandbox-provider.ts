import type {
  SandboxCodeResult,
  SandboxExecResult,
  SandboxFileEditResult,
  SandboxFileReadResult,
  SandboxFileWriteResult,
  SandboxGlobResult,
  SandboxGrepResult,
  SandboxLease,
  SandboxOwner,
  SandboxPreviewResult,
  SandboxProvider,
} from "@ragsystem/backend-core/contracts/sandbox/sandbox-provider.js";

export class SandboxProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "SandboxProviderHttpError";
  }
}

/** Thin HTTP adapter. The bearer token remains private to this process and is never added to tool metadata. */
export class RemoteHttpSandboxProvider implements SandboxProvider {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly requestTimeoutMs: number;

  constructor(input: { baseUrl: string; token: string; requestTimeoutMs?: number; allowInsecureHttp?: boolean }) {
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
    const token = input.token.trim();
    let parsedUrl: URL;
    try { parsedUrl = new URL(baseUrl); } catch { throw new Error("Sandbox baseUrl must be a valid URL"); }
    if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
      throw new Error("Sandbox baseUrl must not contain credentials, query parameters, or fragments");
    }
    const localHttp = parsedUrl.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsedUrl.hostname);
    if (parsedUrl.protocol !== "https:" && !localHttp && input.allowInsecureHttp !== true) {
      throw new Error("Sandbox baseUrl must use HTTPS (plain HTTP is only allowed for localhost)");
    }
    if (!token) throw new Error("Sandbox bearer token is required");
    const requestTimeoutMs = input.requestTimeoutMs ?? 30_000;
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new Error("Sandbox requestTimeoutMs must be a positive integer");
    }
    this.baseUrl = baseUrl;
    this.token = token;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async create(input: Parameters<SandboxProvider["create"]>[0]): Promise<SandboxLease> {
    const result = await this.request("POST", "/v1/sandboxes", input);
    const body = requireRecord(result, "create sandbox response");
    const id = requireString(body.id, "id");
    const owner = requireOwner(body.owner, input.owner);
    return {
      id,
      owner,
      createdAt: optionalString(body.createdAt) ?? new Date().toISOString(),
      expiresAt: optionalString(body.expiresAt),
    };
  }

  async destroy(lease: SandboxLease): Promise<void> {
    await this.request("DELETE", this.sandboxPath(lease));
  }

  async stageInputFile(lease: SandboxLease, input: Parameters<SandboxProvider["stageInputFile"]>[1]): Promise<SandboxFileWriteResult> {
    const body = requireRecord(await this.request("POST", `${this.sandboxPath(lease)}/files/stage-input`, input), "stage input response");
    return { size: requireNumber(body.size, "size") };
  }

  async readFile(lease: SandboxLease, input: Parameters<SandboxProvider["readFile"]>[1]): Promise<SandboxFileReadResult> {
    return requireReadResult(await this.request("POST", `${this.sandboxPath(lease)}/files/read`, withoutSignal(input), input.signal));
  }

  async writeFile(lease: SandboxLease, input: Parameters<SandboxProvider["writeFile"]>[1]): Promise<SandboxFileWriteResult> {
    const body = requireRecord(await this.request("POST", `${this.sandboxPath(lease)}/files/write`, withoutSignal(input), input.signal), "write response");
    return { size: requireNumber(body.size, "size") };
  }

  async editFile(lease: SandboxLease, input: Parameters<SandboxProvider["editFile"]>[1]): Promise<SandboxFileEditResult> {
    const body = requireRecord(await this.request("POST", `${this.sandboxPath(lease)}/files/edit`, withoutSignal(input), input.signal), "edit response");
    return { size: requireNumber(body.size, "size"), replacements: requireNumber(body.replacements, "replacements") };
  }

  async glob(lease: SandboxLease, input: Parameters<SandboxProvider["glob"]>[1]): Promise<SandboxGlobResult> {
    const body = requireRecord(await this.request("POST", `${this.sandboxPath(lease)}/files/glob`, withoutSignal(input), input.signal), "glob response");
    if (!Array.isArray(body.files) || !body.files.every((item) => typeof item === "string")) throw new Error("Invalid sandbox glob files");
    return { files: body.files, truncated: body.truncated === true };
  }

  async grep(lease: SandboxLease, input: Parameters<SandboxProvider["grep"]>[1]): Promise<SandboxGrepResult> {
    const body = requireRecord(await this.request("POST", `${this.sandboxPath(lease)}/files/grep`, withoutSignal(input), input.signal), "grep response");
    if (!Array.isArray(body.matches)) throw new Error("Invalid sandbox grep matches");
    return {
      matches: body.matches.map((raw) => {
        const match = requireRecord(raw, "grep match");
        return {
          file: requireString(match.file, "file"),
          lineNumber: requireNumber(match.lineNumber, "lineNumber"),
          line: requireString(match.line, "line"),
          before: requireStringArray(match.before, "before"),
          after: requireStringArray(match.after, "after"),
        };
      }),
      scannedFiles: requireNumber(body.scannedFiles, "scannedFiles"),
      truncated: body.truncated === true,
    };
  }

  async previewFile(lease: SandboxLease, input: Parameters<SandboxProvider["previewFile"]>[1]): Promise<SandboxPreviewResult> {
    const body = requireRecord(await this.request("POST", `${this.sandboxPath(lease)}/files/preview`, withoutSignal(input), input.signal), "preview response");
    return {
      fileType: requireString(body.fileType, "fileType"),
      fileSize: requireNumber(body.fileSize, "fileSize"),
      structure: requireRecord(body.structure, "structure"),
    };
  }

  async exec(lease: SandboxLease, input: Parameters<SandboxProvider["exec"]>[1]): Promise<SandboxExecResult> {
    return requireExecResult(await this.request(
      "POST",
      `${this.sandboxPath(lease)}/exec`,
      withoutSignal(input),
      input.signal,
      Math.max(this.requestTimeoutMs, (input.timeoutSeconds + 25) * 1_000),
    ));
  }

  async executeCode(lease: SandboxLease, input: Parameters<SandboxProvider["executeCode"]>[1]): Promise<SandboxCodeResult> {
    const body = requireRecord(await this.request(
      "POST",
      `${this.sandboxPath(lease)}/code`,
      withoutSignal(input),
      input.signal,
      Math.max(this.requestTimeoutMs, (input.timeoutSeconds + 25) * 1_000),
    ), "code response");
    return { ...requireExecResult(body), result: body.result };
  }

  private sandboxPath(lease: SandboxLease): string {
    return `/v1/sandboxes/${encodeURIComponent(lease.id)}`;
  }

  private async request(method: string, endpoint: string, body?: unknown, signal?: AbortSignal, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Sandbox request timed out")), timeoutMs);
    const onAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const raw = await response.text();
      let parsed: unknown = null;
      if (raw) {
        try { parsed = JSON.parse(raw); } catch { parsed = { message: raw.slice(0, 500) }; }
      }
      if (!response.ok) {
        const error = isRecord(parsed) ? parsed : {};
        throw new SandboxProviderHttpError(
          this.redact(optionalString(error.message) ?? `Sandbox request failed with HTTP ${response.status}`),
          response.status,
          optionalString(error.code),
        );
      }
      return parsed;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private redact(message: string): string {
    return message.split(this.token).join("[redacted]");
  }
}

function withoutSignal<T extends { signal?: AbortSignal | undefined }>(input: T): Omit<T, "signal"> {
  const { signal: _signal, ...rest } = input;
  return rest;
}

function requireReadResult(value: unknown): SandboxFileReadResult {
  const body = requireRecord(value, "read response");
  return { content: requireString(body.content, "content"), size: requireNumber(body.size, "size") };
}

function requireExecResult(value: unknown): SandboxExecResult {
  const body = requireRecord(value, "exec response");
  return {
    stdout: requireString(body.stdout, "stdout"),
    stderr: requireString(body.stderr, "stderr"),
    returnCode: requireNumber(body.returnCode, "returnCode"),
    interrupted: body.interrupted === true,
    truncated: body.truncated === true,
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid sandbox ${label}`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid sandbox ${label}`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid sandbox ${label}`);
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`Invalid sandbox ${label}`);
  return value;
}

function requireOwner(value: unknown, expected: SandboxOwner): SandboxOwner {
  const owner = requireRecord(value, "owner");
  const tenantId = requireString(owner.tenantId, "owner.tenantId");
  const userId = requireString(owner.userId, "owner.userId");
  const sessionId = requireString(owner.sessionId, "owner.sessionId");
  const runId = requireString(owner.runId, "owner.runId");
  if (
    tenantId !== expected.tenantId
    || userId !== expected.userId
    || sessionId !== expected.sessionId
    || runId !== expected.runId
  ) {
    throw new Error("Sandbox lease owner mismatch");
  }
  return { tenantId: expected.tenantId, userId, sessionId, runId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
