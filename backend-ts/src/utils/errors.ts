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

/**
 * 路由层 service-error → HttpError 的统一骨架：HttpError 原样透传；已知 service 错误交由
 * mapKnown 映射；其余兜底 500 internal_error。各路由只需提供自己的 mapKnown 分支，
 * 不再各自重复透传 + 兜底样板。
 */
export function httpErrorFrom(error: unknown, mapKnown?: (error: Error) => HttpError | null): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof Error) {
    const mapped = mapKnown?.(error);
    if (mapped) {
      return mapped;
    }
  }
  return new HttpError(500, "internal_error", error instanceof Error ? error.message : String(error));
}

/** service 错误的常见映射：404 → not_found，其余 → invalid_request。 */
export function statusHttpError(statusCode: number, message: string): HttpError {
  return new HttpError(statusCode, statusCode === 404 ? "not_found" : "invalid_request", message);
}
