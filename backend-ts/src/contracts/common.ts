import type { ZodType } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface SuccessResponse<T = unknown> {
  success: true;
  message: string;
  data?: T;
}

export interface ErrorResponse {
  success: false;
  message: string;
  code?: string;
  details?: string[];
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface RunStepInfo {
  id: number;
  run_id: string;
  session_id: string;
  message_id: string | null;
  step_order: number;
  step_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export function ok<T>(data?: T, message = "success"): SuccessResponse<T> {
  if (data === undefined) {
    return { success: true, message };
  }
  return { success: true, message, data };
}

export function validateResponse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`REST response contract violation: ${result.error.message}`);
  }
  return value as T;
}
