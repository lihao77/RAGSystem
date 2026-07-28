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
  type: "boolean" | "number" | "password" | "select" | "string_list" | "text" | "textarea";
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

/**
 * 类型化配置组(渐进式实质契约):对应组经 SystemConfigService.getXxxConfig() 暴露类型化访问。
 * SystemConfigData 保持宽泛 Record 以兼容 deepMerge/cloneConfig 与 Python 共享文件;
 * 这些结构化类型仅约束 TS 端读取,不改变磁盘 yaml 结构。
 */
export interface ToolsConfig {
  bash_default_timeout: number;
  bash_max_timeout: number;
  bash_max_output: number;
  code_default_timeout: number;
  code_max_timeout: number;
}

export interface SystemGroupConfig {
  max_content_length: number;
}

export interface DocumentExtractionConfig {
  engine: "builtin" | "cli" | "http";
  cli: { command: string; timeout: number; applies_to: string[] };
  http: { endpoint: string; timeout: number; applies_to: string[] };
}
