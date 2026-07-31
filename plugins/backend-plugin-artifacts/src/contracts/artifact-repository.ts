import type { JsonValue } from "./json.js";

export interface ArtifactMetadata {
  tenant_id: string;
  artifact_id: string;
  session_id: string;
  viz_type: string;
  sub_type: string;
  title: string;
  version: number;
  descriptor_path: string;
  asset_path: string | null;
  artifact_type: "json" | "binary";
  mime_type: string | null;
  config: JsonValue | null;
  created_at: string;
  updated_at: string;
}

export interface CreateArtifactMetadataInput extends Omit<ArtifactMetadata, "created_at" | "updated_at"> { created_at?: string; updated_at?: string; }

export interface ArtifactMetadataRepository {
  get(tenantId: string, artifactId: string): Promise<ArtifactMetadata | null>;
  list(tenantId: string, sessionId?: string | null): Promise<ArtifactMetadata[]>;
  create(input: CreateArtifactMetadataInput): Promise<ArtifactMetadata>;
  updateVersion(tenantId: string, artifactId: string, version: number, config?: JsonValue | null): Promise<ArtifactMetadata | null>;
  delete(tenantId: string, artifactId: string): Promise<boolean>;
}
