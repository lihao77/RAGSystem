import { z } from "zod";

export const SystemConfigUpdateSchema = z.record(z.unknown());

export type SystemConfigUpdate = z.infer<typeof SystemConfigUpdateSchema>;

export interface SystemConfigFieldOption {
  value: string;
  label: string;
}

export interface SystemConfigField {
  key: string;
  label: string;
  type: "boolean" | "number" | "password" | "select" | "text" | "textarea";
  default?: unknown;
  help?: string;
  nullable?: boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: SystemConfigFieldOption[];
}

export interface SystemConfigGroup {
  key: string;
  label: string;
  description: string;
  fields: SystemConfigField[];
}

export interface SystemConfigSchema {
  groups: SystemConfigGroup[];
}

export type SystemConfigValue =
  | string
  | number
  | boolean
  | null
  | SystemConfigValue[]
  | { [key: string]: SystemConfigValue };

export type SystemConfigData = Record<string, SystemConfigValue>;
