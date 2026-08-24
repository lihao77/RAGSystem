/**
 * 流式协议状态机（无标签化改造：轮次判据唯一化为 tool_calls 有无）。
 *
 * 模型输出只有一种结构化标签：<tool_calls>（XML 模式工具调用的唯一表达）。
 * 其余一切文本是裸内容——边流边作为 fallback 事件吐出（流式 output）。
 * 旧协议标签 <intent>/<final_answer>/<answer> 仍被识别并剥离：内容按裸文本
 * 透传、标签本身丢弃，模型旧习惯不会把标签泄漏进答案。
 * 增量 feed(chunk) 返回解析事件；stopAfterClosingTag 提前截断（读完
 * </tool_calls> 即停，不浪费时间读后续）。
 */
export type RuntimeXmlTag = "tool_calls";

/** 被剥离的旧协议标签：内容透传为裸文本，标签丢弃。 */
const LEGACY_TAG_ALIASES: Record<string, string> = {
  intent: "intent",
  final_answer: "final_answer",
  answer: "final_answer",
};

const TAG_ALIASES: Record<string, RuntimeXmlTag> = {
  tool_calls: "tool_calls",
  tools: "tool_calls",
};

export type RuntimeXmlParseEvent =
  | { type: "tag_open" | "content" | "tag_close"; tag: RuntimeXmlTag; content: string }
  | { type: "fallback"; content: string };

export interface RuntimeXmlFeedOptions {
  stopAfterClosingTag?: RuntimeXmlTag | undefined;
}

export class StreamingRuntimeXmlParser {
  private state: RuntimeXmlTag | "legacy" | null = null;
  private legacyTag = "";
  private buffer = "";
  private fullResponse = "";
  private fallbackText = "";
  private toolCallsContent = "";

  feed(chunk: string, options: RuntimeXmlFeedOptions = {}): RuntimeXmlParseEvent[] {
    if (!chunk) {
      return [];
    }
    this.fullResponse += chunk;
    this.buffer += chunk;
    const events: RuntimeXmlParseEvent[] = [];

    while (this.buffer) {
      const eventCountBeforeScan = events.length;
      const consumed = this.state === null ? this.scanForOpenTag(events) : this.scanForCloseTag(events);
      if (!consumed) {
        break;
      }
      if (options.stopAfterClosingTag && hasClosingEvent(events, eventCountBeforeScan, options.stopAfterClosingTag)) {
        if (this.buffer) {
          this.fullResponse = this.fullResponse.slice(0, Math.max(0, this.fullResponse.length - this.buffer.length));
          this.buffer = "";
        }
        break;
      }
    }

    return events;
  }

  getFullResponse(): string {
    return this.fullResponse;
  }

  /**
   * 流结束：冲刷因疑似闭合标签而扣留的尾部缓冲。无标签化后所有正文都是 fallback，
   * 不冲刷会丢掉最多 closeTag+2 字符的结尾（tool_calls 内未闭合属协议错误，不冲出）。
   */
  finish(): RuntimeXmlParseEvent[] {
    const events: RuntimeXmlParseEvent[] = [];
    if (this.state === null && this.buffer) {
      this.emitFallback(events, this.buffer);
      this.buffer = "";
    }
    return events;
  }

  /** 全部裸文本（含旧标签内容；不含 tool_calls 块）。 */
  getFallbackText(): string {
    return this.fallbackText;
  }

  getTagContent(tag: RuntimeXmlTag): string {
    return tag === "tool_calls" ? this.toolCallsContent : "";
  }

  /** 未闭合的结构化标签（用于协议修复判定）；旧标签不闭合不构成协议错误。 */
  get currentState(): RuntimeXmlTag | null {
    return this.state === "tool_calls" ? "tool_calls" : null;
  }

  private scanForOpenTag(events: RuntimeXmlParseEvent[]): boolean {
    const ltPos = this.buffer.indexOf("<");
    if (ltPos === -1) {
      const content = this.buffer;
      this.buffer = "";
      if (content) this.emitFallback(events, content);
      return Boolean(content);
    }
    if (ltPos > 0) {
      this.emitFallback(events, this.buffer.slice(0, ltPos));
      this.buffer = this.buffer.slice(ltPos);
    }

    const gtPos = this.buffer.indexOf(">");
    if (gtPos === -1) {
      return false;
    }

    const rawTag = this.buffer.slice(1, gtPos).trim().toLowerCase();
    const tagName = rawTag.split(/\s+/, 1)[0] ?? "";
    const matchedTag = TAG_ALIASES[tagName];
    const legacyTag = LEGACY_TAG_ALIASES[tagName];
    if (!matchedTag && !legacyTag) {
      // 未知标签（含 <file_ref/> 等内容级标记）按原文透传，由内容解析层处理。
      const content = this.buffer.slice(0, gtPos + 1);
      this.buffer = this.buffer.slice(gtPos + 1);
      this.emitFallback(events, content);
      return true;
    }

    this.buffer = this.buffer.slice(gtPos + 1);
    if (matchedTag) {
      this.state = matchedTag;
      events.push({ type: "tag_open", tag: matchedTag, content: "" });
    } else {
      this.state = "legacy";
      // 存原始标签名：闭合匹配用 </原标签>（<answer> 的闭合是 </answer>，不是映射值）。
      this.legacyTag = tagName;
    }
    return true;
  }

  private scanForCloseTag(events: RuntimeXmlParseEvent[]): boolean {
    if (this.state === null) {
      return false;
    }

    const closeTag = this.state === "tool_calls" ? "</tool_calls>" : `</${this.legacyTag}>`;
    const closePos = this.buffer.toLowerCase().indexOf(closeTag);
    if (closePos !== -1) {
      const contentBefore = this.buffer.slice(0, closePos);
      if (contentBefore) {
        this.accumulate(events, contentBefore);
      }
      this.buffer = this.buffer.slice(closePos + closeTag.length);
      if (this.state === "tool_calls") {
        events.push({ type: "tag_close", tag: "tool_calls", content: "" });
      }
      this.state = null;
      this.legacyTag = "";
      return true;
    }

    const safeLength = this.findSafeContentLength(closeTag);
    if (safeLength > 0) {
      this.accumulate(events, this.buffer.slice(0, safeLength));
      this.buffer = this.buffer.slice(safeLength);
      return true;
    }

    return false;
  }

  /** tool_calls 内容只累积（结构化解析走 parseRuntimeToolCallsXml）；裸/旧标签内容流式透出。 */
  private accumulate(events: RuntimeXmlParseEvent[], content: string): void {
    if (this.state === "tool_calls") {
      this.toolCallsContent += content;
      return;
    }
    this.emitFallback(events, content);
  }

  private emitFallback(events: RuntimeXmlParseEvent[], content: string): void {
    this.fallbackText += content;
    events.push({ type: "fallback", content });
  }

  private findSafeContentLength(closeTag: string): number {
    if (!this.buffer) {
      return 0;
    }
    const maxCloseLength = closeTag.length + 2;
    const checkStart = Math.max(0, this.buffer.length - maxCloseLength);
    const tail = this.buffer.slice(checkStart);
    const lastLt = tail.lastIndexOf("<");
    if (lastLt === -1) {
      return this.buffer.length;
    }

    const partial = tail.slice(lastLt).toLowerCase();
    if (closeTag.startsWith(partial)) {
      return checkStart + lastLt;
    }
    return this.buffer.length;
  }
}

function hasClosingEvent(events: RuntimeXmlParseEvent[], startIndex: number, tag: RuntimeXmlTag): boolean {
  return events.slice(startIndex).some((event) => event.type === "tag_close" && event.tag === tag);
}
