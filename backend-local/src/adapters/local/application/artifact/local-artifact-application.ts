import type { ArtifactApplication, ArtifactRecord } from "@ragsystem/backend-plugin-artifacts/contracts/artifact-application.js";
import type { VisualizationConfig, VisualizationSummary } from "@ragsystem/backend-plugin-artifacts/contracts/artifacts.js";
import type { JsonValue } from "@ragsystem/backend-plugin-artifacts/contracts/json.js";
import { FilesystemArtifactService } from "../../artifacts/filesystem-artifact-service.js";

export class LocalArtifactApplication implements ArtifactApplication {
  constructor(private readonly service: FilesystemArtifactService) {}
  async getVisualization(id: string): Promise<VisualizationConfig> { return this.service.getVisualization(id); }
  async listVisualizations(sessionId: string): Promise<VisualizationSummary[]> { return this.service.listVisualizations(sessionId); }
  async getVisualizationSessionId(id: string): Promise<string | null> { return this.service.getVisualizationSessionId(id); }
  async createChart(input: { sessionId: string; chartConfig: JsonValue; chartType?: string | null; title?: string | null }): Promise<ArtifactRecord> { return this.service.createChart(input); }
  async createMap(input: { sessionId: string; mapData: JsonValue; mapType?: string | null; title?: string | null }): Promise<ArtifactRecord> { return this.service.createMap(input); }
  async reviseVisualization(input: { artifactId: string; configPatch: JsonValue; replace?: boolean | null }): Promise<ArtifactRecord> { return this.service.reviseVisualization(input); }
  async deleteVisualization(id: string): Promise<boolean> { return this.service.deleteVisualization(id); }
  async deleteSessionVisualizations(sessionId: string): Promise<number> { return this.service.deleteSessionVisualizations(sessionId); }
}
