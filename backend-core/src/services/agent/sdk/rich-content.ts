import {
  AssistantContentPartSchema,
  type AssistantContentPart as WireAssistantContentPart,
} from "@ragsystem/agent-protocol";
import {
  normalizeWorkspaceRelativePath,
  type AssistantContentPart as KernelAssistantContentPart,
} from "@ragsystem/agent-sdk";

export interface RichContentExtension {
  kind: "rich_content";
  version: 1;
  slot: "replace";
  data: { parts: WireAssistantContentPart[] };
}

export function createRichContentExtension(
  parts: readonly KernelAssistantContentPart[] | null | undefined,
): RichContentExtension | null {
  if (!parts?.some((part) => part.type === "file_ref")) return null;
  const normalized: WireAssistantContentPart[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      normalized.push({ type: "text", text: part.text });
      continue;
    }
    const filePath = normalizeWorkspaceRelativePath(part.filePath);
    if (!filePath) continue;
    normalized.push({
      type: "file_ref",
      file_path: filePath,
      presentation: part.presentation,
      ...(part.caption?.trim() ? { caption: part.caption.trim() } : {}),
    });
  }
  if (!normalized.some((part) => part.type === "file_ref")) return null;
  return { kind: "rich_content", version: 1, slot: "replace", data: { parts: normalized } };
}

export function mergeRichContentExtension(
  metadata: Record<string, unknown>,
  extension: RichContentExtension | null,
): Record<string, unknown> {
  if (!extension) return metadata;
  const existing = Array.isArray(metadata.extensions)
    ? metadata.extensions.filter((item) => !isRichContentExtension(item))
    : [];
  return { ...metadata, extensions: [...existing, extension] };
}

export function readRichContentParts(metadata: Record<string, unknown> | null | undefined): WireAssistantContentPart[] | null {
  if (!Array.isArray(metadata?.extensions)) return null;
  const extension = metadata.extensions.find(isRichContentExtension);
  if (!extension || !isRecord(extension.data) || !Array.isArray(extension.data.parts)) return null;
  const parts = extension.data.parts.flatMap((part) => {
    const parsed = AssistantContentPartSchema.safeParse(part);
    return parsed.success ? [parsed.data] : [];
  });
  return parts.some((part) => part.type === "file_ref") ? parts : null;
}

function isRichContentExtension(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.kind === "rich_content" && value.version === 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
