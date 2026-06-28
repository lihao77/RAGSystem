import { z } from "zod";

export const optionalString = z.string().optional().nullable();
export const optionalInteger = z.number().int().optional().nullable();
export const optionalBoolean = z.boolean().optional().nullable();
export const optionalRecord = z.record(z.unknown()).optional().nullable();

export function nullableStringArray(): z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodString, "many">>> {
  return z.array(z.string()).nullable().optional();
}

export function metadataFrom<T extends {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  riskLevel?: unknown;
  allowed_callers?: string[] | undefined;
  source?: unknown;
  category?: string | undefined;
  usage_contract?: string[] | undefined;
  examples?: unknown[] | undefined;
  extended_usage?: string | undefined;
  returns?: unknown;
  observationPolicy?: "default" | "inline" | undefined;
}>(definition: T) {
  const base = {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
  };
  // exactOptionalPropertyTypes 下不能显式写入 undefined 字段，按需展开。
  if (definition.riskLevel !== undefined) {
    (base as Record<string, unknown>).riskLevel = definition.riskLevel as never;
  }
  if (definition.allowed_callers !== undefined) {
    (base as Record<string, unknown>).allowedCallers = definition.allowed_callers;
  }
  if (definition.source !== undefined) {
    (base as Record<string, unknown>).source = definition.source as never;
  }
  if (definition.category !== undefined) {
    (base as Record<string, unknown>).category = definition.category;
  }
  if (definition.usage_contract !== undefined) {
    (base as Record<string, unknown>).usageContract = definition.usage_contract;
  }
  if (definition.examples !== undefined) {
    (base as Record<string, unknown>).examples = definition.examples;
  }
  if (definition.extended_usage !== undefined) {
    (base as Record<string, unknown>).extendedUsage = definition.extended_usage;
  }
  if (definition.returns !== undefined) {
    (base as Record<string, unknown>).returns = definition.returns as never;
  }
  if (definition.observationPolicy !== undefined) {
    (base as Record<string, unknown>).observationPolicy = definition.observationPolicy;
  }
  return base;
}
