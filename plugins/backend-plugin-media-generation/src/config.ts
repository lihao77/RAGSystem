import { z } from "zod";

import type { SystemConfigExtension } from "@ragsystem/backend-core/contracts/runtime/system-config.js";

import { MEDIA_VENDORS } from "./provider-types.js";

export const MEDIA_IMAGE_CONFIG_KEY = "media_image";
export const MEDIA_VIDEO_CONFIG_KEY = "media_video";

/**
 * 插件自管 Provider 配置：厂商 + API Key + 端点 + 模型全部存插件配置段，
 * 不依赖也不写入 core 的模型 Provider 体系。
 *
 * 解析采用宽容剥离（非 strict）：core 对配置段是 deepMerge 存储，前端 bug 或
 * 旧版本残留写入的未知键（如曾被注入的 provider/provider_type）只被忽略，
 * 不能让整段解析失败回默认值——那会静默丢掉 enabled/api_key。
 */
const ImageConfigSchema = z.object({
  enabled: z.boolean().optional().default(false),
  vendor: z.string().optional().default(""),
  api_key: z.string().optional().default(""),
  /** 留空使用厂商默认端点。 */
  api_endpoint: z.string().optional().default(""),
  timeout: z.number().int().min(5).max(600).optional().default(120),
  model_name: z.string().optional().default(""),
  /** 已废弃：仅兼容旧存量配置，读取时折算进 model_name（model_name 非空则忽略）。 */
  custom_model: z.string().optional().default(""),
  default_resolution: z.enum(["1k", "2k", "4k"]).optional().default("1k"),
});

const VideoConfigSchema = z.object({
  enabled: z.boolean().optional().default(false),
  vendor: z.string().optional().default(""),
  api_key: z.string().optional().default(""),
  api_endpoint: z.string().optional().default(""),
  timeout: z.number().int().min(5).max(600).optional().default(120),
  model_name: z.string().optional().default(""),
  /** 已废弃：仅兼容旧存量配置，读取时折算进 model_name（model_name 非空则忽略）。 */
  custom_model: z.string().optional().default(""),
  default_resolution: z.enum(["720p", "1080p"]).optional().default("720p"),
  wait_timeout_seconds: z.number().int().min(30).max(900).optional().default(240),
});

export type MediaImageConfig = Omit<z.infer<typeof ImageConfigSchema>, "custom_model">;
export type MediaVideoConfig = Omit<z.infer<typeof VideoConfigSchema>, "custom_model">;

/** 旧 custom_model 字段折算：model_name 为空时兜底使用，随后即淘汰。 */
function foldLegacyCustomModel<T extends { model_name: string; custom_model: string }>(data: T): Omit<T, "custom_model"> {
  const { custom_model, ...rest } = data;
  return { ...rest, model_name: (rest.model_name || custom_model).trim() };
}

export function resolveImageConfig(value: unknown): MediaImageConfig {
  const parsed = ImageConfigSchema.safeParse(value);
  if (!parsed.success) return ImageConfigSchema.parse({});
  return foldLegacyCustomModel(parsed.data);
}

export function resolveVideoConfig(value: unknown): MediaVideoConfig {
  const parsed = VideoConfigSchema.safeParse(value);
  if (!parsed.success) return VideoConfigSchema.parse({});
  return foldLegacyCustomModel(parsed.data);
}

const VENDOR_OPTIONS = MEDIA_VENDORS.map((vendor) => ({ value: vendor.value, label: vendor.label }));

export const MEDIA_SYSTEM_CONFIG_EXTENSION: SystemConfigExtension = {
  defaults: {
    [MEDIA_IMAGE_CONFIG_KEY]: ImageConfigSchema.parse({}),
    [MEDIA_VIDEO_CONFIG_KEY]: VideoConfigSchema.parse({}),
  },
  groups: [
    {
      key: MEDIA_IMAGE_CONFIG_KEY,
      label: "图像生成",
      description: "generate_image 工具：文生图/图生图。选择厂商并填写该厂商的 API Key 与生图模型名。",
      fields: [
        { key: "enabled", label: "启用图像生成", type: "boolean", default: false, help: "开启后 agent 可使用 generate_image 工具。" },
        { key: "vendor", label: "厂商", type: "select", default: "", options: VENDOR_OPTIONS, help: "媒体生成厂商（凭证与模型均为插件自管，不占用模型 Provider 条目）。" },
        { key: "api_key", label: "API Key", type: "password", default: "", help: "该厂商开放平台的 API Key。" },
        { key: "api_endpoint", label: "API Endpoint（可选）", type: "text", default: "", help: "留空使用厂商默认端点；代理/私有部署时填写。" },
        { key: "timeout", label: "请求超时（秒）", type: "number", default: 120, min: 5, max: 600, help: "单次 API 请求（提交/查询/下载）的超时时间。" },
        { key: "model_name", label: "模型名", type: "text", default: "", help: "该厂商的生图模型 ID（如 glm-image、doubao-seedream-5-0-pro）；目录外新模型亦可填写，能力按厂商默认处理。" },
        { key: "default_resolution", label: "默认分辨率档", type: "select", default: "1k", options: [{ value: "1k", label: "1K" }, { value: "2k", label: "2K" }, { value: "4k", label: "4K" }] },
      ],
    },
    {
      key: MEDIA_VIDEO_CONFIG_KEY,
      label: "视频生成",
      description: "generate_video / check_video_task 工具：文生视频/图生视频。选择厂商并填写该厂商的 API Key 与生视频模型名。",
      fields: [
        { key: "enabled", label: "启用视频生成", type: "boolean", default: false, help: "开启后 agent 可使用 generate_video 工具。" },
        { key: "vendor", label: "厂商", type: "select", default: "", options: VENDOR_OPTIONS, help: "媒体生成厂商（魔搭社区仅支持生图，请勿用于视频）。" },
        { key: "api_key", label: "API Key", type: "password", default: "", help: "该厂商开放平台的 API Key。" },
        { key: "api_endpoint", label: "API Endpoint（可选）", type: "text", default: "", help: "留空使用厂商默认端点；代理/私有部署时填写。" },
        { key: "timeout", label: "请求超时（秒）", type: "number", default: 120, min: 5, max: 600, help: "单次 API 请求（提交/查询/下载）的超时时间。" },
        { key: "model_name", label: "模型名", type: "text", default: "", help: "该厂商的生视频模型 ID（如 cogvideox-3、doubao-seedance-2-0）；目录外新模型亦可填写，能力按厂商默认处理。" },
        { key: "default_resolution", label: "默认分辨率", type: "select", default: "720p", options: [{ value: "720p", label: "720p" }, { value: "1080p", label: "1080p" }] },
        { key: "wait_timeout_seconds", label: "等待超时（秒）", type: "number", default: 240, min: 30, max: 900, help: "generate_video 阻塞等待上限；超时后返回 task_ref，用 check_video_task 续查。" },
      ],
    },
  ],
};
