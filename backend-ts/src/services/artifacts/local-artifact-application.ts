import type { JsonValue } from "../../contracts/common.js";
import type { ArtifactApplication, ArtifactRecord } from "../../contracts/artifact-application.js";
import type { VisualizationConfig, VisualizationSummary } from "../../contracts/artifacts.js";
import { ArtifactService } from "./artifact-service.js";

/** Async tenant application facade over Local's filesystem ArtifactService. */
export class LocalArtifactApplication implements ArtifactApplication {
  constructor(private readonly service: ArtifactService) {}
  async getVisualization(id: string): Promise<VisualizationConfig> { return this.service.getVisualization(id); }
  async listVisualizations(sessionId: string): Promise<VisualizationSummary[]> { return this.service.listVisualizations(sessionId); }
  async getVisualizationSessionId(id: string): Promise<string | null> { return this.service.getVisualizationSessionId(id); }
  async createChart(input: { sessionId: string; chartConfig: JsonValue; chartType?: string | null; title?: string | null }): Promise<ArtifactRecord> { return this.service.createChart(input); }
  async createMap(input: { sessionId: string; mapData: JsonValue; mapType?: string | null; title?: string | null }): Promise<ArtifactRecord> { return this.service.createMap(input); }
  async reviseVisualization(input: { artifactId: string; configPatch: JsonValue; replace?: boolean | null }): Promise<ArtifactRecord> { return this.service.reviseVisualization(input); }
  async deleteVisualization(id: string): Promise<boolean> { return this.service.deleteVisualization(id); }
  async deleteSessionVisualizations(sessionId: string): Promise<number> { return this.service.deleteSessionVisualizations(sessionId); }
}
