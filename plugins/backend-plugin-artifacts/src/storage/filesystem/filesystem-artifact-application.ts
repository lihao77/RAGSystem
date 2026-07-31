import type {
  ArtifactApplication,
  ArtifactAssetContent,
  ArtifactCreateInput,
  ArtifactRecord,
  ArtifactRevisionInput,
} from "../../contracts/artifact-application.js";
import type { ArtifactManifest, ArtifactSummary } from "../../contracts/artifacts.js";
import { FilesystemArtifactService } from "./filesystem-artifact-service.js";

export class FilesystemArtifactApplication implements ArtifactApplication {
  constructor(private readonly service: FilesystemArtifactService) {}
  async getArtifact(id: string): Promise<ArtifactManifest> { return this.service.getArtifact(id); }
  async getArtifactAsset(id: string, assetId: string): Promise<ArtifactAssetContent> { return this.service.getArtifactAsset(id, assetId); }
  async listArtifacts(sessionId: string): Promise<ArtifactSummary[]> { return this.service.listArtifacts(sessionId); }
  async getArtifactSessionId(id: string): Promise<string | null> { return this.service.getArtifactSessionId(id); }
  async createArtifact(input: ArtifactCreateInput): Promise<ArtifactRecord> { return this.service.createArtifact(input); }
  async reviseArtifact(input: ArtifactRevisionInput): Promise<ArtifactRecord> { return this.service.reviseArtifact(input); }
  async deleteArtifact(id: string): Promise<boolean> { return this.service.deleteArtifact(id); }
  async deleteSessionArtifacts(sessionId: string): Promise<number> { return this.service.deleteSessionArtifacts(sessionId); }
}
