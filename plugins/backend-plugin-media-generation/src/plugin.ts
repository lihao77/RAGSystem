import type { BackendPlugin, BackendToolDescriptor } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import { MEDIA_IMAGE_CONFIG_KEY, MEDIA_SYSTEM_CONFIG_EXTENSION, MEDIA_VIDEO_CONFIG_KEY, resolveImageConfig, resolveVideoConfig } from "./config.js";
import { MEDIA_PROVIDER_TYPES } from "./provider-types.js";
import { buildCheckVideoTaskTool, CHECK_VIDEO_TASK_TOOL_NAME } from "./tools/CheckVideoTaskTool.js";
import { buildGenerateImageTool, GENERATE_IMAGE_TOOL_NAME } from "./tools/GenerateImageTool.js";
import { buildGenerateVideoTool, GENERATE_VIDEO_TOOL_NAME } from "./tools/GenerateVideoTool.js";

export const PLUGIN_ID = "@ragsystem/backend-plugin-media-generation";

export const TOOL_DESCRIPTORS: readonly BackendToolDescriptor[] = [
  {
    name: GENERATE_IMAGE_TOOL_NAME,
    description: "文生图/图生图（参考图）：生成图片保存到会话工作区，聊天内内联展示。",
    category: "media",
    risk_level: "low",
  },
  {
    name: GENERATE_VIDEO_TOOL_NAME,
    description: "文生视频/图生视频（首尾帧）：异步生成，等待超时返回 task_ref 供续查。",
    category: "media",
    risk_level: "low",
  },
  {
    name: CHECK_VIDEO_TASK_TOOL_NAME,
    description: "查询视频生成任务（task_ref）状态，完成则落盘返回视频文件。",
    category: "media",
    risk_level: "low",
  },
];

export function createMediaGenerationPlugin(): BackendPlugin {
  return {
    manifest: { id: PLUGIN_ID, version: "0.1.0" },
    register(context) {
      // 1) Provider 类型注册：Provider 管理页出现“xx · 图像/视频生成”类型（key/endpoint 由系统统一管理）。
      context.providerTypes.register(MEDIA_PROVIDER_TYPES);

      // 2) Agent 工具（各 agent 在 enabled_tools 中勾选启用）。
      context.tools.register((factoryContext) => {
        const enabled = new Set(factoryContext.agent.tools.enabled_tools ?? []);
        const tools = [];
        if (enabled.has(GENERATE_IMAGE_TOOL_NAME)) tools.push(buildGenerateImageTool(factoryContext));
        if (enabled.has(GENERATE_VIDEO_TOOL_NAME)) tools.push(buildGenerateVideoTool(factoryContext));
        if (enabled.has(CHECK_VIDEO_TASK_TOOL_NAME)) tools.push(buildCheckVideoTaskTool(factoryContext));
        return tools;
      }, TOOL_DESCRIPTORS);

      // 3) 设置页配置组（注册时回灌已存值，避免 rebuildProjection 丢配置——skills/pet 同款模式）。
      context.runtimes.register((runtimeContext) => {
        const unregister = runtimeContext.systemConfig.registerExtension(PLUGIN_ID, {
          ...MEDIA_SYSTEM_CONFIG_EXTENSION,
          defaults: {
            [MEDIA_IMAGE_CONFIG_KEY]: resolveImageConfig(runtimeContext.systemConfig.getSection(MEDIA_IMAGE_CONFIG_KEY)),
            [MEDIA_VIDEO_CONFIG_KEY]: resolveVideoConfig(runtimeContext.systemConfig.getSection(MEDIA_VIDEO_CONFIG_KEY)),
          },
        });
        return { dispose: unregister };
      });
    },
  };
}
