import { z } from "zod";

export const ExtractorKindSchema = z.enum(["text", "pdf", "docx", "unknown"]);
export type ExtractorKind = z.infer<typeof ExtractorKindSchema>;

export const ExtractInputSchema = z.object({
  file_path: z.string().trim().min(1),
  file_name: z.string().trim().optional(),
  mime: z.string().trim().optional().nullable(),
});
export type ExtractInput = z.infer<typeof ExtractInputSchema>;

export const ExtractResultSchema = z.object({
  text: z.string(),
  kind: ExtractorKindSchema,
});
export type ExtractResult = z.infer<typeof ExtractResultSchema>;

/** 文档解析器契约。实现负责读取输入文件并返回可索引文本。 */
export interface DocumentExtractor {
  extract(input: ExtractInput): Promise<ExtractResult>;
}
