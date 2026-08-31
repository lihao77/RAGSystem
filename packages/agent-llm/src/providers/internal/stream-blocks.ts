/**
 * 流式归一内容块累加器（pi-ai 块模型）：provider 侧 index 寻址，跨 chunk 追加。
 *
 * 每个块携带 provider 流里的序号（anthropic content_block index / openai tool_call index /
 * responses output_index），delta 按 index 定位目标块；工具参数进 partialJson 暂存区，
 * collect() 时原样定稿为 arguments 字符串并剥离全部暂存字段——partialJson 只在流式期间
 * 存在，绝不外泄到 LlmResult/续传态。文本/思考块同理按出现顺序拼接。
 */
import type { ChatToolCall, ReasoningBlock } from "../../types.js";

export interface StreamTextBlock {
  kind: "text";
  index: number;
  text: string;
}

export interface StreamThinkingBlock {
  kind: "thinking";
  index: number;
  thinking: string;
  signature: string;
}

export interface StreamToolCallBlock {
  kind: "toolCall";
  index: number;
  id: string;
  name: string;
  partialJson: string;
}

export type StreamBlock = StreamTextBlock | StreamThinkingBlock | StreamToolCallBlock;

export class StreamingBlocks {
  private readonly blocks: StreamBlock[] = [];

  /** 按 index 开块（同 index 重复开 = 幂等返回已开块，容忍网关重复 content_block_start）。 */
  open<T extends StreamBlock>(block: T): T {
    const existing = this.find(block.index);
    if (existing && existing.kind === block.kind) return existing as T;
    if (existing) this.blocks.splice(this.blocks.indexOf(existing), 1);
    this.blocks.push(block);
    return block;
  }

  find(index: number): StreamBlock | undefined {
    return this.blocks.find((block) => block.index === index);
  }

  appendText(index: number, delta: string): void {
    const block = this.expect(index, "text") ?? this.open({ kind: "text", index, text: "" });
    block.text += delta;
  }

  appendThinking(index: number, delta: string): void {
    const block = this.expect(index, "thinking") ?? this.open({ kind: "thinking", index, thinking: "", signature: "" });
    block.thinking += delta;
  }

  appendSignature(index: number, delta: string): void {
    const block = this.expect(index, "thinking") ?? this.open({ kind: "thinking", index, thinking: "", signature: "" });
    block.signature += delta;
  }

  appendToolArguments(index: number, delta: string): void {
    const block = this.expect(index, "toolCall");
    if (block) block.partialJson += delta;
  }

  /** 文本按块 index 序拼接（同一文本块的跨 chunk 增量已就位累积）。 */
  text(): string {
    return this.blocks
      .filter((block): block is StreamTextBlock => block.kind === "text")
      .sort((a, b) => a.index - b.index)
      .map((block) => block.text)
      .join("");
  }

  /** 带签名的思考块 → 续传态 ReasoningBlock（无签名的丢弃，与 Anthropic 签名校验要求一致）。 */
  reasoningBlocks(): ReasoningBlock[] {
    return this.reasoningEntries().map((entry) => entry.block);
  }

  /** 同上，但保留 provider 侧 index——redacted_thinking 等终块合并排序时用。 */
  reasoningEntries(): { index: number; block: ReasoningBlock }[] {
    return this.blocks
      .filter((block): block is StreamThinkingBlock => block.kind === "thinking")
      .sort((a, b) => a.index - b.index)
      .flatMap((block): { index: number; block: ReasoningBlock }[] => {
        if (!block.signature) return [];
        return [{ index: block.index, block: { type: "thinking", thinking: block.thinking, signature: block.signature } }];
      });
  }

  reasoningText(): string {
    return this.blocks
      .filter((block): block is StreamThinkingBlock => block.kind === "thinking")
      .sort((a, b) => a.index - b.index)
      .map((block) => block.thinking)
      .join("");
  }

  /** 全部工具块（含 name 未到的），index 升序——流内去重/计数用。 */
  toolCallBlocks(): readonly StreamToolCallBlock[] {
    return this.blocks
      .filter((block): block is StreamToolCallBlock => block.kind === "toolCall")
      .sort((a, b) => a.index - b.index);
  }

  /** 工具调用按 index 升序定稿：arguments = partialJson 原样（我们的契约保留原始 JSON 字符串）。 */
  toolCalls(): ChatToolCall[] {
    return this.toolCallBlocks()
      .filter((block) => block.name)
      .map((block) => ({ id: block.id, type: "function", function: { name: block.name, arguments: block.partialJson } }));
  }

  private expect<T extends StreamBlock["kind"]>(index: number, kind: T): Extract<StreamBlock, { kind: T }> | undefined {
    const block = this.find(index);
    return block?.kind === kind ? (block as Extract<StreamBlock, { kind: T }>) : undefined;
  }
}
