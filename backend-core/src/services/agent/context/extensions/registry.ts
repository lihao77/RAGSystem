/**
 * ProjectionRegistry——投影器按 kind 注册/查找。
 * recent-source 组装 conversation 时遍历消息 extensions,经此 registry 投影进 LLM content。
 */
import type { ContentPart } from "@ragsystem/agent-llm";
import type { ExtensionProjector, ProjectContext } from "./types.js";
import type { MessageExtension } from "./kinds.js";

export class ProjectionRegistry {
  private readonly byKind = new Map<string, ExtensionProjector>();

  register(projector: ExtensionProjector): void {
    if (this.byKind.has(projector.kind)) {
      throw new Error(`ExtensionProjector 已注册: ${projector.kind}`);
    }
    this.byKind.set(projector.kind, projector);
  }

  /** 投影单个扩展;未注册 kind 或 projector 返回 null 表示不投影(纯展示型)。 */
  async project(ext: MessageExtension, ctx: ProjectContext): Promise<ContentPart[] | string | null> {
    return this.byKind.get(ext.kind)?.project(ext, ctx) ?? null;
  }
}
