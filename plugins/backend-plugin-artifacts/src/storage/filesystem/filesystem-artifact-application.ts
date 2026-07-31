import type { ArtifactApplication, ArtifactAssetInput, ArtifactContent, ArtifactRecord } from "../../contracts/artifact-application.js";
import type { ArtifactDescriptor, ArtifactSummary } from "../../contracts/artifacts.js";
import type { JsonValue } from "../../contracts/json.js";
import { FilesystemArtifactService } from "./filesystem-artifact-service.js";

export class FilesystemArtifactApplication implements ArtifactApplication {
  constructor(private readonly service: FilesystemArtifactService) {}
  async getArtifact(id: string): Promise<ArtifactDescriptor> { return this.service.getArtifact(id); }
  async getArtifactContent(id: string): Promise<ArtifactContent | null> { return this.service.getArtifactContent(id); }
  async listArtifacts(sessionId: string): Promise<ArtifactSummary[]> { return this.service.listArtifacts(sessionId); }
  async getArtifactSessionId(id: string): Promise<string | null> { return this.service.getArtifactSessionId(id); }
  async createArtifact(input: { sessionId: string; vizType: string; subType?: string | null; title?: string | null; config?: JsonValue | null; asset?: ArtifactAssetInput | null }): Promise<ArtifactRecord> { return this.service.createArtifact(input); }
  async reviseArtifact(input: { artifactId: string; configPatch: JsonValue; replace?: boolean | null }): Promise<ArtifactRecord> { return this.service.reviseArtifact(input); }
  async deleteArtifact(id: string): Promise<boolean> { return this.service.deleteArtifact(id); }
  async deleteSessionArtifacts(sessionId: string): Promise<number> { return this.service.deleteSessionArtifacts(sessionId); }
}
