/**
 * createDefaultProjectionRegistry——装配 backend 默认投影器集合。
 * 消费端(runtime-adapter 生产装配 / monitoring 只读 preview)调用,
 * 得到注册了内置 metadata projector(ui_context / tool_result_media)的 registry。
 */
import { ProjectionRegistry } from "./registry.js";
import { uiContextProjector } from "./ui-context-projector.js";
import { toolResultMediaProjector } from "./tool-result-media-projector.js";

export function createDefaultProjectionRegistry(): ProjectionRegistry {
  const registry = new ProjectionRegistry();
  registry.register(uiContextProjector);
  registry.register(toolResultMediaProjector);
  return registry;
}
