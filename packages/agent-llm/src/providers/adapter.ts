import type { LlmRequest, LlmResult, LlmStreamHandler } from "../types.js";

export interface LlmProviderAdapter {
  complete(request: LlmRequest): Promise<LlmResult>;
  stream(request: LlmRequest, onChunk: LlmStreamHandler): Promise<LlmResult>;
}
