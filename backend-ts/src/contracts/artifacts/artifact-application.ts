import type { JsonValue } from "../common.js";
import type { VisualizationConfig, VisualizationSummary } from "./artifacts.js";

export interface ArtifactRecord {
  artifact_id: string;
  viz_type: string;
  sub_type: string;
  title: string;
  version: number;
  file_path: string;
  session_id: string | null;
  created_at: number | string;
  updated_at: number | string;
}

export interface ArtifactApplication {
  getVisualization(artifactId: string): Promise<VisualizationConfig>;
  listVisualizations(sessionId: string): Promise<VisualizationSummary[]>;
  getVisualizationSessionId(artifactId: string): Promise<string | null>;
  createChart(input: { sessionId: string; chartConfig: JsonValue; chartType?: string | null; title?: string | null }): Promise<ArtifactRecord>;
  createMap(input: { sessionId: string; mapData: JsonValue; mapType?: string | null; title?: string | null }): Promise<ArtifactRecord>;
  reviseVisualization(input: { artifactId: string; configPatch: JsonValue; replace?: boolean | null }): Promise<ArtifactRecord>;
  deleteVisualization(artifactId: string): Promise<boolean>;
  deleteSessionVisualizations(sessionId: string): Promise<number>;
}
