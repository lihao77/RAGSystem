export interface RagChatErrorOptions extends ErrorOptions {
  code?: string;
  status?: number;
  details?: unknown;
}

export class RagChatError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(message: string, options: RagChatErrorOptions = {}) {
    super(message, options);
    this.name = "RagChatError";
    this.code = options.code ?? "RAG_CHAT_ERROR";
    this.status = options.status ?? 0;
    this.details = options.details;
  }
}

export class RagChatHttpError extends RagChatError {
  constructor(status: number, message = `HTTP ${status}`, details?: unknown) {
    super(message, { code: "HTTP_ERROR", status, details });
    this.name = "RagChatHttpError";
  }
}
