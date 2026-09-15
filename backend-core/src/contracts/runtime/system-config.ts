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
  /** 该组来自哪个扩展（约定为插件 manifest id）；内置组无此字段。插件设置页按它分组。 */
  sourceExtension?: string;
  /** 声明后宿主前端将 provider/model_name 渲染为下拉并按提示过滤/联动。 */
  providerSelect?: SystemConfigProviderSelectHints;
}

/**
 * provider/model 下拉增强提示，由组定义方（内置 schema 或插件扩展）自声明，
 * 宿主前端不内置任何具体组名。含 provider/model_name 字段的组默认渲染下拉，
 * 提示只改变过滤与联动行为。
 */
export interface SystemConfigProviderSelectHints {
  /** 只列出支持视觉的 Provider（视觉辅助组用）。 */
  visionOnly?: boolean;
  /** 切换 Provider 时自动选择其第一个模型（系统默认 LLM 用）；缺省则清空 model_name 等待手选。 */
  autoSelectModel?: boolean;
  /** 切换 Provider 时从 Provider 同名字段回填到组配置的字段名（值非空时以 Number 写入）。 */
  applyProviderFields?: readonly string[];
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

/** System-level LLM fallback used when an agent has no LLM tier configuration. */
export interface SystemLlmConfig {
  provider: string;
  provider_type: string;
  model_name: string;
  temperature: number;
  max_completion_tokens: number;
  max_context_tokens: number;
  extra_params: Record<string, SystemConfigValue>;
}

export interface SystemGroupConfig {
  max_content_length: number;
}

/** Extension contribution owned by one plugin. */
export interface SystemConfigExtension {
  readonly defaults: SystemConfigData;
  readonly groups: readonly SystemConfigGroup[];
}

/** Read and extension-registration surface available to plugins. */
export interface SystemConfigPort {
  getSection(key: string): SystemConfigValue | undefined;
  getToolsConfig(): ToolsConfig;
  /**
   * 系统 LLM 兜底配置（agent default 档引用失效回落用）。SystemConfigService
   * 实装；测试替身/裁剪实现可缺省——缺省时调用方不做系统回落。
   */
  getLlmConfig?(): SystemLlmConfig;
  registerExtension(id: string, extension: SystemConfigExtension): () => void;
}
