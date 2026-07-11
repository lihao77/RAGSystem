import fs from "node:fs/promises";
import path from "node:path";
import { externalCallPolicy, isRetryableHttpStatus, RetryableHttpError } from "@ragsystem/agent-llm";
import type { DocumentExtractor, ExtractResult } from "../../../../contracts/knowledge/document-extractor.js";

export class HttpExtractor implements DocumentExtractor {
  constructor(private readonly endpoint: string, private readonly timeoutSeconds: number) {}

  async extract(input: Parameters<DocumentExtractor["extract"]>[0]): Promise<ExtractResult> {
    const buffer = await fs.readFile(input.file_path);
    const form = new FormData();
    form.append("file", new Blob([buffer]), input.file_name ?? path.basename(input.file_path));
    const response = await externalCallPolicy.execute({
      key: `document-extractor:http:${this.endpoint}`,
      timeoutMs: this.timeoutSeconds * 1000,
      operation: async ({ signal }) => {
        const response = await fetch(this.endpoint, { method: "POST", body: form, signal });
        if (isRetryableHttpStatus(response.status)) throw new RetryableHttpError(response.status, `Document extraction failed with HTTP ${response.status}`);
        return response;
      },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(text || `Document extraction failed with HTTP ${response.status}`);
    return { text, kind: "text" };
  }
}
