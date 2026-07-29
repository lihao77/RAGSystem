import { z } from "zod";

export const ValidateFilesRequestSchema = z.object({
  file_ids: z.array(z.string()).optional().default([]),
});

export const LinkSessionFileRequestSchema = z.object({
  path: z.string().min(1),
  original_name: z.string().min(1).optional(),
  mime: z.string().optional().default("application/octet-stream"),
});

export type SessionFileStorageKind = "managed" | "linked_local";

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
  scope_type: "session";
  scope_id: string | null;
  storage_kind?: SessionFileStorageKind;
  local_path?: string;
}

export type ValidateFilesRequest = z.infer<typeof ValidateFilesRequestSchema>;
export type LinkSessionFileRequest = z.infer<typeof LinkSessionFileRequestSchema>;
