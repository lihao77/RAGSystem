import { z } from "zod";

import type { SystemConfigExtension } from "@ragsystem/backend-core/contracts/runtime/system-config.js";

export const MEDIA_IMAGE_CONFIG_KEY = "media_image";
export const MEDIA_VIDEO_CONFIG_KEY = "media_video";

const ImageConfigSchema = z.object({
  enabled: z.boolean().optional().default(false),
  /** 媒体 Provider 条目的名称/key（标准字段名：宿主渲染为 Provider 下拉）。 */
  provider: z.string().optional().default(""),
  provider_type: z.string().optional().default(""),
  /** 生成模型（标准字段名：自动渲染为所选 Provider 的模型下拉；模型在 Provider 条目上配置）。 */
  model_name: z.string().optional().default(""),
  /** 条目模型列表外的新模型手填；非空时优先生效。 */
  custom_model: z.string().optional().default(""),
  default_resolution: z.enum(["1k", "2k", "4k"]).optional().default("1k"),
}).strict();

const VideoConfigSchema = z.object({
  enabled: z.boolean().optional().default(false),
  provider: z.string().optional().default(""),
  provider_type: z.string().optional().default(""),
  model_name: z.string().optional().default(""),
  custom_model: z.string().optional().default(""),
  default_resolution: z.enum(["720p", "1080p"]).optional().default("720p"),
  wait_timeout_seconds: z.number().int().min(30).max(900).optional().default(240),
}).strict();

export type MediaImageConfig = z.infer<typeof ImageConfigSchema>;
export type MediaVideoConfig = z.infer<typeof VideoConfigSchema>;

export function resolveImageConfig(value: unknown): MediaImageConfig {
  const parsed = ImageConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : ImageConfigSchema.parse({});
}

export function resolveVideoConfig(value: unknown): MediaVideoConfig {
  const parsed = VideoConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : VideoConfigSchema.parse({});
}

/**
 * 两组均含标准 provider/provider_type/model_name 字段：宿主前端自动渲染
 * “Provider 下拉 + 所选条目的模型下拉”联动（模型名在 Provider 页面的模型映射配置）。
 */
export const MEDIA_SYSTEM_CONFIG_EXTENSION: SystemConfigExtension = {
  defaults: {
    [MEDIA_IMAGE_CONFIG_KEY]: ImageConfigSchema.parse({}),
    [MEDIA_VIDEO_CONFIG_KEY]: VideoConfigSchema.parse({}),
  },
  groups: [
    {
      key: MEDIA_IMAGE_CONFIG_KEY,
      label: "图像生成",
      description: "generate_image 工具：文生图/图生图。先在「模型 Provider 管理」创建“图像生成”类型条目（选厂商、填 Key、在模型映射配置生图模型），再在此选择该 Provider 与模型。",
      fields: [
        { key: "enabled", label: "启用图像生成", type: "boolean", default: false, help: "开启后 agent 可使用 generate_image 工具。" },
        { key: "provider", label: "Provider", type: "text", default: "", help: "选择“图像生成”类型的媒体 Provider 条目。" },
        { key: "provider_type", label: "Provider Type", type: "text", default: "", help: "由所选 Provider 自动带出。" },
        { key: "model_name", label: "生成模型", type: "text", default: "", help: "下拉列出所选 Provider 条目上配置的生图模型。" },
        { key: "custom_model", label: "自定义模型名", type: "text", default: "", help: "条目模型列表未收录的新模型可手填，非空时优先生效。" },
        { key: "default_resolution", label: "默认分辨率档", type: "select", default: "1k", options: [{ value: "1k", label: "1K" }, { value: "2k", label: "2K" }, { value: "4k", label: "4K" }] },
      ],
    },
    {
      key: MEDIA_VIDEO_CONFIG_KEY,
      label: "视频生成",
      description: "generate_video / check_video_task 工具：文生视频/图生视频。先在「模型 Provider 管理」创建“视频生成”类型条目（选厂商、填 Key、在模型映射配置生视频模型），再在此选择该 Provider 与模型。",
      fields: [
        { key: "enabled", label: "启用视频生成", type: "boolean", default: false, help: "开启后 agent 可使用 generate_video 工具。" },
        { key: "provider", label: "Provider", type: "text", default: "", help: "选择“视频生成”类型的媒体 Provider 条目。" },
        { key: "provider_type", label: "Provider Type", type: "text", default: "", help: "由所选 Provider 自动带出。" },
        { key: "model_name", label: "生成模型", type: "text", default: "", help: "下拉列出所选 Provider 条目上配置的生视频模型。" },
        { key: "custom_model", label: "自定义模型名", type: "text", default: "", help: "条目模型列表未收录的新模型可手填，非空时优先生效。" },
        { key: "default_resolution", label: "默认分辨率", type: "select", default: "720p", options: [{ value: "720p", label: "720p" }, { value: "1080p", label: "1080p" }] },
        { key: "wait_timeout_seconds", label: "等待超时（秒）", type: "number", default: 240, min: 30, max: 900, help: "generate_video 阻塞等待上限；超时后返回 task_ref，用 check_video_task 续查。" },
      ],
    },
  ],
};
