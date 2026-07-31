import type { ArtifactStatus } from "./artifacts.js";

export interface ArtifactMetadata {
  tenant_id: string;
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

export interface CreateArtifactMetadataInput extends Omit<ArtifactMetadata, "created_at" | "updated_at"> {
  created_at?: string;
  updated_at?: string;
}

export interface ArtifactMetadataRepository {
  get(tenantId: string, artifactId: string): Promise<ArtifactMetadata | null>;
  list(tenantId: string, sessionId?: string | null): Promise<ArtifactMetadata[]>;
  create(input: CreateArtifactMetadataInput): Promise<ArtifactMetadata>;
  updateRevision(input: {
    tenantId: string;
    artifactId: string;
    revision: number;
    title: string;
    status: ArtifactStatus;
    presentationCount: number;
  }): Promise<ArtifactMetadata | null>;
  delete(tenantId: string, artifactId: string): Promise<boolean>;
}
