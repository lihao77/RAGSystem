export {
  parseRuntimeToolCallsXml,
  type RuntimeToolCallParseResult,
} from "./runtime-xml-protocol/tool-calls.js";
export {
  isSemanticTaggedContent,
  renderProtocolFeedbackMessage,
  renderRuntimeXmlProtocolInstruction,
  renderSemanticBlock,
  renderToolResultContent,
  renderToolResultMessage,
} from "./runtime-xml-protocol/rendering.js";

export type RuntimeXmlTag = "intent" | "tool_calls" | "final_answer";

export interface RuntimeXmlParseEvent {
  type: "tag_open" | "content" | "tag_close";
  tag: RuntimeXmlTag;
  content: string;
}

const TAG_ALIASES: Record<string, RuntimeXmlTag> = {
  intent: "intent",
  tool_calls: "tool_calls",
  tools: "tool_calls",
  final_answer: "final_answer",
  answer: "final_answer",
};

export class StreamingRuntimeXmlParser {
  private state: RuntimeXmlTag | null = null;
  private buffer = "";
  private fullResponse = "";
  private readonly tagContents: Record<RuntimeXmlTag, string> = {
    intent: "",
    tool_calls: "",
    final_answer: "",
  };

  feed(chunk: string): RuntimeXmlParseEvent[] {
    if (!chunk) {
      return [];
    }
    this.fullResponse += chunk;
    this.buffer += chunk;
    const events: RuntimeXmlParseEvent[] = [];

    while (this.buffer) {
      const consumed = this.state === null ? this.scanForOpenTag(events) : this.scanForCloseTag(events);
      if (!consumed) {
        break;
      }
    }

    return events;
  }

  getFullResponse(): string {
    return this.fullResponse;
  }

  getTagContent(tag: RuntimeXmlTag): string {
    return this.tagContents[tag];
  }

  get currentState(): RuntimeXmlTag | null {
    return this.state;
  }

  private scanForOpenTag(events: RuntimeXmlParseEvent[]): boolean {
    const ltPos = this.buffer.indexOf("<");
    if (ltPos === -1) {
      return false;
    }
    if (ltPos > 0) {
      this.buffer = this.buffer.slice(ltPos);
    }

    const gtPos = this.buffer.indexOf(">");
    if (gtPos === -1) {
      return false;
    }

    const rawTag = this.buffer.slice(1, gtPos).trim().toLowerCase();
    const tagName = rawTag.split(/\s+/, 1)[0] ?? "";
    const matchedTag = TAG_ALIASES[tagName];
    this.buffer = this.buffer.slice(gtPos + 1);
    if (!matchedTag) {
      return true;
    }

    this.state = matchedTag;
    events.push({ type: "tag_open", tag: matchedTag, content: "" });
    return true;
  }

  private scanForCloseTag(events: RuntimeXmlParseEvent[]): boolean {
    if (this.state === null) {
      return false;
    }

    const closeMatch = this.findCloseTagMatch(this.state);
    if (closeMatch) {
      const [closePos, closeTag] = closeMatch;
      const contentBefore = this.buffer.slice(0, closePos);
      if (contentBefore) {
        this.tagContents[this.state] += contentBefore;
        if (this.state === "intent" || this.state === "final_answer") {
          events.push({ type: "content", tag: this.state, content: contentBefore });
        }
      }
      events.push({ type: "tag_close", tag: this.state, content: "" });
      this.buffer = this.buffer.slice(closePos + closeTag.length);
      this.state = null;
      return true;
    }

    const safeLength = this.findSafeContentLength();
    if (safeLength > 0) {
      const content = this.buffer.slice(0, safeLength);
      this.tagContents[this.state] += content;
      if (this.state === "intent" || this.state === "final_answer") {
        events.push({ type: "content", tag: this.state, content });
      }
      this.buffer = this.buffer.slice(safeLength);
      return true;
    }

    return false;
  }

  private findCloseTagMatch(tag: RuntimeXmlTag): [number, string] | null {
    const matches: Array<[number, string]> = [];
    for (const closeTag of closeTagsForTag(tag)) {
      const closePos = this.buffer.toLowerCase().indexOf(closeTag);
      if (closePos !== -1) {
        matches.push([closePos, closeTag]);
      }
    }
    matches.sort((left, right) => left[0] - right[0]);
    return matches[0] ?? null;
  }

  private findSafeContentLength(): number {
    if (!this.buffer) {
      return 0;
    }
    const maxCloseLength = 18;
    const checkStart = Math.max(0, this.buffer.length - maxCloseLength);
    const tail = this.buffer.slice(checkStart);
    const lastLt = tail.lastIndexOf("<");
    if (lastLt === -1) {
      return this.buffer.length;
    }

    const partial = tail.slice(lastLt).toLowerCase();
    for (const closeTag of allCloseTags()) {
      if (closeTag.startsWith(partial)) {
        return checkStart + lastLt;
      }
    }
    return this.buffer.length;
  }
}

function closeTagsForTag(tag: RuntimeXmlTag): string[] {
  if (tag === "final_answer") {
    return ["</final_answer>", "</answer>"];
  }
  if (tag === "tool_calls") {
    return ["</tool_calls>", "</tools>"];
  }
  return ["</intent>"];
}

function allCloseTags(): string[] {
  return ["</intent>", "</tool_calls>", "</tools>", "</final_answer>", "</answer>"];
}
