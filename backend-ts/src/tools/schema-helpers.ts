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
  approvalExempt?: boolean | undefined;
  source?: unknown;
  category?: string | undefined;
  usage_contract?: string[] | undefined;
  examples?: unknown[] | undefined;
  extended_usage?: string | undefined;
  returns?: unknown;
}>(definition: T) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    riskLevel: definition.riskLevel as never,
    allowedCallers: definition.allowed_callers,
    approvalExempt: definition.approvalExempt,
    source: definition.source as never,
    category: definition.category,
    usageContract: definition.usage_contract,
    examples: definition.examples,
    extendedUsage: definition.extended_usage,
    returns: definition.returns as never,
  };
}
