export { backendPluginModule } from "./module.js";
export { createMediaGenerationPlugin, PLUGIN_ID, TOOL_DESCRIPTORS } from "./plugin.js";
export {
  MEDIA_IMAGE_CONFIG_KEY,
  MEDIA_VIDEO_CONFIG_KEY,
  MEDIA_SYSTEM_CONFIG_EXTENSION,
  resolveImageConfig,
  resolveVideoConfig,
} from "./config.js";
export { MEDIA_VENDORS, findMediaVendor } from "./provider-types.js";
export type { MediaAdapterId, MediaVendorInfo } from "./provider-types.js";
export { MODEL_CATALOG, findModelEntry, adapterDefaultCaps } from "./model-catalog.js";
export { GENERATE_IMAGE_TOOL_NAME, executeGenerateImage, MEDIA_IMAGE_EVENTS } from "./tools/GenerateImageTool.js";
export { GENERATE_VIDEO_TOOL_NAME, CHECK_VIDEO_TASK_TOOL_NAME, executeGenerateVideo, MEDIA_VIDEO_EVENTS } from "./tools/GenerateVideoTool.js";
export { executeCheckVideoTask } from "./tools/CheckVideoTaskTool.js";
export { getMediaAdapter, resolveModelCaps, normalizeImageParams, normalizeVideoParams } from "./providers/registry.js";
export type { MediaGenAdapter, AdapterCallContext } from "./providers/types.js";
