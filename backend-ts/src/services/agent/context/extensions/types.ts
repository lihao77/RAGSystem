/**
 * 投影子系统类型。纯函数契约:扩展 data → 注入 LLM content 的文本/parts。
 * 会话附件通过 session_id + file_id 异步读取；工具瞬态图片仍由同步 reader 读取。
 * 渲染是前端独立子系统(前端 RENDERERS registry),不在本目录。
 */
import type { ContentPart } from "@ragsystem/agent-llm";
import type { ExtensionKind, MessageExtension } from "./kinds.js";

export interface AttachmentReadResult {
  body: Uint8Array;
  contentType: string | null;
}

export type AttachmentReader = (sessionId: string, fileId: string) => Promise<AttachmentReadResult | null>;
export type ToolImageReader = (storedPath: string, mime: string) => string | null;

export interface ProjectContext {
  role: string;
  sessionId: string;
  supportsVision: boolean;
  readAttachment: AttachmentReader;
  readToolImage: ToolImageReader;
}

/** 投影器:返回 null = 纯展示型,不进 LLM content。 */
export interface ExtensionProjector {
  kind: ExtensionKind;
  project(extension: MessageExtension, ctx: ProjectContext): ContentPart[] | string | null | Promise<ContentPart[] | string | null>;
}
