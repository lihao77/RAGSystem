import type { JsonValue } from "./json.js";
import type { ArtifactDescriptor, ArtifactSummary } from "./artifacts.js";

export interface ArtifactAssetInput {
  body: Uint8Array;
  mimeType: string;
  filename?: string | null;
}

export interface ArtifactContent {
  body: Uint8Array;
  mimeType: string;
  filename: string | null;
}

export interface ArtifactRecord {
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
  created_at: number | string;
  updated_at: number | string;
}

export interface ArtifactApplication {
  getArtifact(artifactId: string): Promise<ArtifactDescriptor>;
  getArtifactContent(artifactId: string): Promise<ArtifactContent | null>;
  listArtifacts(sessionId: string): Promise<ArtifactSummary[]>;
  getArtifactSessionId(artifactId: string): Promise<string | null>;
  createArtifact(input: {
    sessionId: string;
    vizType: string;
    subType?: string | null;
    title?: string | null;
    config?: JsonValue | null;
    asset?: ArtifactAssetInput | null;
  }): Promise<ArtifactRecord>;
  reviseArtifact(input: { artifactId: string; configPatch: JsonValue; replace?: boolean | null }): Promise<ArtifactRecord>;
  deleteArtifact(artifactId: string): Promise<boolean>;
  deleteSessionArtifacts(sessionId: string): Promise<number>;
}
