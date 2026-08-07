export type AssistantFilePresentation = "inline" | "attachment" | "preview";

export type AssistantContentPart =
  | { type: "text"; text: string }
  | {
      type: "file_ref";
      filePath: string;
      presentation: AssistantFilePresentation;
      caption?: string;
    };

export type AssistantContentStreamEvent =
  | { type: "text_delta"; partIndex: number; content: string }
  | { type: "file_ref"; partIndex: number; part: Extract<AssistantContentPart, { type: "file_ref" }> };

const FILE_REF_OPEN = "<file_ref";

/** Incrementally converts the model's file markers into canonical assistant content parts. */
export class StreamingAssistantContentParser {
  private buffer = "";
  private readonly parts: AssistantContentPart[] = [];
  private finished = false;

  feed(chunk: string): AssistantContentStreamEvent[] {
    if (this.finished || !chunk) return [];
    this.buffer += chunk;
    const events: AssistantContentStreamEvent[] = [];

    while (this.buffer) {
      const markerStart = this.buffer.indexOf(FILE_REF_OPEN);
      if (markerStart < 0) {
        const safeLength = safeTextLength(this.buffer);
        if (safeLength === 0) break;
        this.appendText(this.buffer.slice(0, safeLength), events);
        this.buffer = this.buffer.slice(safeLength);
        continue;
      }
      if (markerStart > 0) {
        this.appendText(this.buffer.slice(0, markerStart), events);
        this.buffer = this.buffer.slice(markerStart);
        continue;
      }

      const markerEnd = findTagEnd(this.buffer);
      if (markerEnd < 0) break;
      const rawMarker = this.buffer.slice(0, markerEnd);
      this.buffer = this.buffer.slice(markerEnd);
      const file = parseFileRefMarker(rawMarker);
      if (!file) {
        this.appendText(rawMarker, events);
        continue;
      }
      const partIndex = this.parts.length;
      this.parts.push(file);
      events.push({ type: "file_ref", partIndex, part: file });
    }

    return events;
  }

  finish(): AssistantContentStreamEvent[] {
    if (this.finished) return [];
    this.finished = true;
    if (!this.buffer) return [];
    const events: AssistantContentStreamEvent[] = [];
    this.appendText(this.buffer, events);
    this.buffer = "";
    return events;
  }

  getParts(): AssistantContentPart[] {
    return this.parts.map((part) => ({ ...part }));
  }

  getFallbackContent(): string {
    return renderAssistantContentFallback(this.parts);
  }

  private appendText(content: string, events: AssistantContentStreamEvent[]): void {
    if (!content) return;
    const previous = this.parts.at(-1);
    const partIndex = previous?.type === "text" ? this.parts.length - 1 : this.parts.length;
    if (previous?.type === "text") previous.text += content;
    else this.parts.push({ type: "text", text: content });
    events.push({ type: "text_delta", partIndex, content });
  }
}

export function parseAssistantContent(content: string): {
  content: string;
  parts: AssistantContentPart[];
  hasFileRefs: boolean;
} {
  const parser = new StreamingAssistantContentParser();
  parser.feed(content);
  parser.finish();
  const parts = parser.getParts();
  return {
    content: parser.getFallbackContent(),
    parts,
    hasFileRefs: parts.some((part) => part.type === "file_ref"),
  };
}


export function renderAssistantContentFallback(parts: readonly AssistantContentPart[]): string {
  return parts.map((part) => {
    if (part.type === "text") return part.text;
    const label = part.caption?.trim() || part.filePath.split("/").at(-1) || part.filePath;
    return `\n\nFile: ${label} (${part.filePath})\n\n`;
  }).join("");
}

function safeTextLength(value: string): number {
  const maxPrefix = Math.min(value.length, FILE_REF_OPEN.length - 1);
  for (let length = maxPrefix; length > 0; length -= 1) {
    if (FILE_REF_OPEN.startsWith(value.slice(-length))) return value.length - length;
  }
  return value.length;
}

function findTagEnd(value: string): number {
  let quote: "\"" | "'" | null = null;
  for (let index = FILE_REF_OPEN.length; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return index + 1;
  }
  return -1;
}

function parseFileRefMarker(rawMarker: string): Extract<AssistantContentPart, { type: "file_ref" }> | null {
  if (!rawMarker.endsWith("/>")) return null;
  const attributes = parseAttributes(rawMarker.slice(FILE_REF_OPEN.length, -2));
  if (!attributes) return null;
  const allowed = new Set(["path", "presentation", "caption"]);
  if (Object.keys(attributes).some((name) => !allowed.has(name))) return null;
  const filePath = normalizeWorkspaceRelativePath(attributes.path);
  if (!filePath) return null;
  const presentation = attributes.presentation || "attachment";
  if (presentation !== "inline" && presentation !== "attachment" && presentation !== "preview") return null;
  const caption = attributes.caption?.trim();
  return {
    type: "file_ref",
    filePath,
    presentation,
    ...(caption ? { caption } : {}),
  };
}

function parseAttributes(source: string): Record<string, string> | null {
  const attributes: Record<string, string> = {};
  let remaining = source;
  const attributePattern = /^\s+([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/;
  while (remaining.trim()) {
    const match = attributePattern.exec(remaining);
    if (!match) return null;
    const name = match[1]!;
    if (Object.hasOwn(attributes, name)) return null;
    attributes[name] = decodeXmlAttribute(match[2] ?? match[3] ?? "");
    remaining = remaining.slice(match[0].length);
  }
  return attributes;
}

function decodeXmlAttribute(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function normalizeWorkspaceRelativePath(value: string | undefined): string | null {
  const input = value?.trim().replaceAll("\\", "/");
  if (!input || input.includes("\0") || input.startsWith("/") || /^[A-Za-z]:\//.test(input)) return null;
  const segments: string[] = [];
  for (const segment of input.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") return null;
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : null;
}
