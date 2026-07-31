import type { JsonObject, JsonValue } from "./json.js";

export type ArtifactStatus = "ready" | "failed";

export interface ArtifactAsset {
  asset_id: string;
  role: string;
  filename: string;
  media_type: string;
  size: number;
  sha256: string;
  content_url: string;
}

export interface ArtifactPresentation {
  presentation_id: string;
  surface: string;
  renderer: string;
  assets: Record<string, string>;
  config: JsonValue;
}

export interface ArtifactRelation {
  relation: string;
  target_id: string;
  target_kind?: string;
}

export interface ArtifactManifest {
  schema_version: 2;
  artifact_id: string;
  revision: number;
  session_id: string;
  kind: string;
  subtype: string;
  title: string;
  status: ArtifactStatus;
  assets: ArtifactAsset[];
  presentations: ArtifactPresentation[];
  metadata: JsonObject;
  provenance: JsonObject;
  relations: ArtifactRelation[];
  created_at: string;
  updated_at: string;
}

export interface ArtifactIndexEntry {
  schema_version: 2;
  artifact_id: string;
  session_id: string;
  kind: string;
  subtype: string;
  title: string;
  status: ArtifactStatus;
  revision: number;
  manifest_path: string;
  asset_count: number;
  presentation_count: number;
  created_at: string;
  updated_at: string;
}

export interface ArtifactSummary {
  schema_version: 2;
  artifact_id: string;
  session_id: string;
  kind: string;
  subtype: string;
  title: string;
  status: ArtifactStatus;
  revision: number;
  asset_count: number;
  presentation_count: number;
  created_at: string;
  updated_at: string;
}
