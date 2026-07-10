/**
 * 投影子系统类型。纯函数契约:扩展 data → 注入 LLM content 的文本/parts。
 * 无 IO,读盘经 ctx.readImage 注入(沿用 attachment-image 模式)。
 * 渲染是前端独立子系统(前端 RENDERERS registry),不在本目录。
 */
import type { ContentPart } from "@ragsystem/agent-llm";
import type { ImageReader } from "../attachment-image.js";
import type { ExtensionKind } from "./kinds.js";

export interface ProjectContext {
  role: string;
  supportsVision: boolean;
  readImage: ImageReader;
  readToolImage?: ImageReader;
}

/** 投影器:返回 null = 纯展示型,不进 LLM content。 */
export interface ExtensionProjector {
  kind: ExtensionKind;
  project(data: Record<string, unknown>, ctx: ProjectContext): ContentPart[] | string | null;
}
