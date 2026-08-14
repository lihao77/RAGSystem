import { z } from "zod";

import type { SystemConfigExtension } from "@ragsystem/backend-core/contracts/runtime/system-config.js";

/** 图片理解配置组 key（systemConfig.getSection / UI 配置页）。 */
export const IMAGE_TOOLS_CONFIG_KEY = "image_tools";

export const ImageToolsSystemConfigSchema = z.object({
  /** 总开关：开启后对用户消息中的图片生成文字描述并随消息持久化。 */
  enabled: z.boolean().optional().default(false),
  /** 视觉辅助 Provider 的名称或 key；留空不启用（不做自动回退）。 */
  provider: z.string().optional().default(""),
  /** 可选，用于避免同名 Provider 冲突。 */
  provider_type: z.string().optional().default(""),
  /** 辅助视觉模型名称；留空不启用。 */
  model_name: z.string().optional().default(""),
  max_completion_tokens: z.number().int().positive().optional().default(1200),
  timeout_seconds: z.number().int().positive().optional().default(60),
  cache_enabled: z.boolean().optional().default(true),
}).strict();

export type ImageToolsSystemConfig = z.infer<typeof ImageToolsSystemConfigSchema>;

export const IMAGE_TOOLS_SYSTEM_CONFIG_EXTENSION: SystemConfigExtension = {
  defaults: { [IMAGE_TOOLS_CONFIG_KEY]: ImageToolsSystemConfigSchema.parse({}) },
  groups: [
    {
      key: IMAGE_TOOLS_CONFIG_KEY,
      label: "图片理解",
      description: "为不支持视觉输入的主模型提供图片文字描述（用户消息与 view_image 工具）。",
      fields: [
        {
          key: "enabled",
          label: "启用图片理解",
          type: "boolean",
          default: false,
          help: "开启后，用户消息中的图片会由视觉辅助模型生成文字描述，并随消息一起持久化。",
        },
        {
          key: "cache_enabled",
          label: "启用缓存",
          type: "boolean",
          default: true,
          help: "相同图片内容只生成一次描述，命中缓存直接复用。",
        },
        {
          key: "provider",
          label: "Provider",
          type: "text",
          default: "",
          help: "填写系统模型中支持视觉的 Provider 名称或 key；留空则不启用辅助功能。",
        },
        {
          key: "provider_type",
          label: "Provider Type",
          type: "text",
          default: "",
          help: "可选，用于避免同名 Provider 冲突。",
        },
        {
          key: "model_name",
          label: "Model Name",
          type: "text",
          default: "",
          help: "辅助视觉模型名称；留空则不启用辅助功能。",
        },
        {
          key: "max_completion_tokens",
          label: "Max Completion Tokens",
          type: "number",
          default: 1200,
          min: 1,
          step: 1,
        },
        {
          key: "timeout_seconds",
          label: "Timeout Seconds",
          type: "number",
          default: 60,
          min: 1,
          step: 1,
        },
      ],
    },
  ],
};

export function resolveImageToolsSystemConfig(value: unknown): ImageToolsSystemConfig {
  const parsed = ImageToolsSystemConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : ImageToolsSystemConfigSchema.parse({});
}

/** 辅助功能是否可用：用户显式开启且填写了 provider 与 model_name（不做自动回退）。 */
export function isVisionHelperEnabled(config: ImageToolsSystemConfig): boolean {
  return config.enabled === true && config.provider.trim() !== "" && config.model_name.trim() !== "";
}
