import type { JsonValue } from "./common.js";

export interface VisualizationIndexEntry {
  artifact_id: string;
  viz_type: string;
  sub_type: string;
  title: string;
  version: number;
  file_path: string;
  artifact_type: string;
  mime_type: string | null;
  session_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface VisualizationSummary {
  artifact_id: string;
  viz_type: string;
  sub_type: string;
  title: string;
  version: number;
  created_at: number;
  updated_at: number;
}

export type VisualizationConfig = Record<string, JsonValue>;
