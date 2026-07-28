import type { JsonValue } from "../common.js";
import type { ArtifactRecord } from "./artifact-application.js";

export interface ArtifactWriter {
  createChart(input: {
    sessionId: string;
    chartConfig: JsonValue;
    chartType?: string | null;
    title?: string | null;
  }): ArtifactRecord;
  createMap(input: {
    sessionId: string;
    mapData: JsonValue;
    mapType?: string | null;
    title?: string | null;
  }): ArtifactRecord;
  reviseVisualization(input: {
    artifactId: string;
    configPatch: JsonValue;
    replace?: boolean | null;
  }): ArtifactRecord;
}
