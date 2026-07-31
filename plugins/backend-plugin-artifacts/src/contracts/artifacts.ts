import type { JsonValue } from "./json.js";

export interface ArtifactIndexEntry {
  artifact_id: string;
  viz_type: string;
  sub_type: string;
  title: string;
  version: number;
  descriptor_path: string;
  asset_path: string | null;
  artifact_type: "json" | "binary";
  mime_type: string | null;
  session_id: string;
  created_at: number;
  updated_at: number;
}

export interface ArtifactSummary {
  artifact_id: string;
  viz_type: string;
  sub_type: string;
  title: string;
  version: number;
  artifact_type: "json" | "binary";
  mime_type: string | null;
  has_content: boolean;
  created_at: number;
  updated_at: number;
}

export interface ArtifactDescriptor extends Record<string, JsonValue> {
  artifact_id: string;
  viz_type: string;
  sub_type: string;
  title: string;
  version: number;
  artifact_type: "json" | "binary";
  mime_type: string | null;
  content_url: string | null;
  config: JsonValue;
}
