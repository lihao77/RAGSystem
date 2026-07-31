import type { JsonObject, JsonValue } from "./json.js";
import type {
  ArtifactManifest,
  ArtifactPresentation,
  ArtifactRelation,
  ArtifactStatus,
  ArtifactSummary,
} from "./artifacts.js";

export interface ArtifactAssetInput {
  assetId: string;
  role: string;
  body: Uint8Array;
  mediaType: string;
  filename?: string | null;
}

export interface ArtifactAssetContent {
  body: Uint8Array;
  mediaType: string;
  filename: string;
  sha256: string;
}

export interface ArtifactCreateInput {
  sessionId: string;
  kind: string;
  subtype?: string | null;
  title?: string | null;
  status?: ArtifactStatus | null;
  assets?: ArtifactAssetInput[] | null;
  presentations?: ArtifactPresentation[] | null;
  metadata?: JsonObject | null;
  provenance?: JsonObject | null;
  relations?: ArtifactRelation[] | null;
}

export interface ArtifactPresentationPatch {
  presentationId: string;
  configPatch: JsonValue;
  replace?: boolean | null;
}

export interface ArtifactRevisionInput {
  artifactId: string;
  title?: string | null;
  status?: ArtifactStatus | null;
  metadata?: JsonObject | null;
  provenance?: JsonObject | null;
  relations?: ArtifactRelation[] | null;
  presentations?: ArtifactPresentation[] | null;
  presentationPatches?: ArtifactPresentationPatch[] | null;
  replace?: boolean | null;
}

export interface ArtifactRecord {
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

export interface ArtifactApplication {
  getArtifact(artifactId: string): Promise<ArtifactManifest>;
  getArtifactAsset(artifactId: string, assetId: string): Promise<ArtifactAssetContent>;
  listArtifacts(sessionId: string): Promise<ArtifactSummary[]>;
  getArtifactSessionId(artifactId: string): Promise<string | null>;
  createArtifact(input: ArtifactCreateInput): Promise<ArtifactRecord>;
  reviseArtifact(input: ArtifactRevisionInput): Promise<ArtifactRecord>;
  deleteArtifact(artifactId: string): Promise<boolean>;
  deleteSessionArtifacts(sessionId: string): Promise<number>;
}
