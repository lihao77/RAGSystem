import type { ErrorResponse } from "../contracts/common.js";

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: string[];

  constructor(statusCode: number, code: string, message: string, details?: string[]) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export class NotMigratedError extends HttpError {
  constructor(capability: string) {
    super(501, "not_migrated", `${capability} has not been migrated to TypeScript yet`);
  }
}

export function formatError(error: HttpError): ErrorResponse {
  const response: ErrorResponse = {
    success: false,
    message: error.message,
    code: error.code,
  };
  if (error.details?.length) {
    response.details = error.details;
  }
  return response;
}
