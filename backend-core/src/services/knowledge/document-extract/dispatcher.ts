import type { DocumentExtractionConfig } from "../../../contracts/runtime/system-config.js";
import type { DocumentExtractor, ExtractInput, ExtractResult, ExtractorKind } from "../../../contracts/knowledge/document-extractor.js";
import { KnowledgeBaseError } from "../../../contracts/knowledge/knowledge-base.js";
import { getBuiltinExtractor } from "./builtin/index.js";
import { CliExtractor } from "./external/cli-extractor.js";
import { HttpExtractor } from "./external/http-extractor.js";
import { detectExtractorKind } from "./type-detect.js";

export class DocumentExtractDispatcher implements DocumentExtractor {
  constructor(private readonly config: DocumentExtractionConfig) {}

  async extract(input: ExtractInput): Promise<ExtractResult> {
    const kind = detectExtractorKind(input);
    if (kind === "unknown") throw new KnowledgeBaseError("不支持的二进制文档格式", 415);
    const external = this.resolveExternal(kind);
    if (external) return external.extract(input);
    const builtin = getBuiltinExtractor(kind);
    if (!builtin) throw new KnowledgeBaseError(`不支持的文档格式: ${kind}`, 415);
    return builtin.extract(input);
  }

  private resolveExternal(kind: ExtractorKind): DocumentExtractor | null {
    if (this.config.engine === "cli" && appliesTo(this.config.cli.applies_to, kind)) {
      if (!this.config.cli.command) throw new Error("CLI document extractor command is required");
      return new CliExtractor(this.config.cli.command, this.config.cli.timeout);
    }
    if (this.config.engine === "http" && appliesTo(this.config.http.applies_to, kind)) {
      if (!this.config.http.endpoint) throw new Error("HTTP document extractor endpoint is required");
      return new HttpExtractor(this.config.http.endpoint, this.config.http.timeout);
    }
    return null;
  }
}

function appliesTo(values: string[], kind: ExtractorKind): boolean {
  return values.length === 0 || values.includes(kind);
}
