import { z } from "zod";

export const ValidateFilesRequestSchema = z.object({
  file_ids: z.array(z.string()).optional().default([]),
});

export interface UploadedFileRecord {
  id: string;
  original_name: string;
  stored_name: string;
  stored_path: string;
  size: number;
  mime: string;
  uploaded_at: string;
  uploaded_by: string | null;
  indexed_in_vector: boolean;
  tags: string | null;
  notes: string | null;
  scope_type: "global" | "session";
  scope_id: string | null;
}

export type ValidateFilesRequest = z.infer<typeof ValidateFilesRequestSchema>;
