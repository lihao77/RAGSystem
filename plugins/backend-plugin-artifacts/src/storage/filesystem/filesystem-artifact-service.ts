import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  VisualizationConfig,
  VisualizationIndexEntry,
  VisualizationSummary,
} from "../../contracts/artifacts.js";
import type { JsonValue } from "../../contracts/json.js";
import { ArtifactServiceError } from "../../artifact-error.js";

export interface VisualizationRecord {
  artifact_id: string;
  viz_type: string;
  sub_type: string;
  title: string;
  version: number;
  file_path: string;
  session_id: string | null;
  created_at: number;
  updated_at: number;
}

export class FilesystemArtifactService {
  private readonly dataRoot: string;
  private readonly sessionsRoot: string;

  constructor(options: { dataRoot?: string | undefined }) {
    if (!options.dataRoot?.trim()) {
      throw new Error("FilesystemArtifactService 必须传入已解析的 dataRoot");
    }
    this.dataRoot = path.resolve(options.dataRoot);
    this.sessionsRoot = path.join(this.dataRoot, "sessions");
  }

  getVisualization(artifactId: string): VisualizationConfig {
    const record = this.findVisualization(artifactId);
    if (!record) {
      throw new ArtifactServiceError(`未找到可视化 artifact: ${artifactId}`, 404);
    }

    if (record.viz_type === "image") {
      return {
        artifact_id: record.artifact_id,
        viz_type: "image",
        sub_type: record.sub_type || "png",
        title: record.title,
        version: record.version,
        image_url: record.file_path,
      };
    }

    const filePath = this.resolveManagedFile(record.file_path);
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      throw new ArtifactServiceError(`可视化 artifact 配置无效: ${artifactId}`, 500);
    }
    return parsed as VisualizationConfig;
  }

  listVisualizations(sessionId: string): VisualizationSummary[] {
    return this.readSessionEntries(sessionId).map((record) => ({
      artifact_id: record.artifact_id,
      viz_type: record.viz_type,
      sub_type: record.sub_type,
      title: record.title,
      version: record.version,
      created_at: record.created_at,
      updated_at: record.updated_at,
    }));
  }

  getVisualizationSessionId(artifactId: string): string | null {
    return this.findVisualizationWithSession(artifactId)?.sessionId ?? null;
  }

  createChart(input: {
    sessionId: string | null | undefined;
    chartConfig: JsonValue;
    chartType?: string | null | undefined;
    title?: string | null | undefined;
  }): VisualizationRecord {
    return this.createVisualization({
      sessionId: input.sessionId,
      vizType: "chart",
      subType: normalizeString(input.chartType) ?? "bar",
      title: normalizeString(input.title) ?? "",
      config: input.chartConfig,
    });
  }

  createMap(input: {
    sessionId: string | null | undefined;
    mapData: JsonValue;
    mapType?: string | null | undefined;
    title?: string | null | undefined;
  }): VisualizationRecord {
    return this.createVisualization({
      sessionId: input.sessionId,
      vizType: "map",
      subType: normalizeString(input.mapType) ?? "marker",
      title: normalizeString(input.title) ?? "",
      config: input.mapData,
    });
  }

  reviseVisualization(input: {
    artifactId: string;
    configPatch: JsonValue;
    replace?: boolean | null | undefined;
  }): VisualizationRecord {
    const located = this.findVisualizationWithSession(input.artifactId);
    if (!located) {
      throw new ArtifactServiceError(`未找到可视化 artifact: ${input.artifactId}`, 404);
    }
    if (located.entry.viz_type === "image") {
      throw new ArtifactServiceError("图片类型的 artifact 不支持修改配置");
    }

    const filePath = this.resolveManagedFile(located.entry.file_path);
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(raw)) {
      throw new ArtifactServiceError(`可视化 artifact 配置无效: ${input.artifactId}`, 500);
    }
    const currentConfig = raw.config ?? {};
    const nextConfig = input.replace ? input.configPatch : deepMergeJson(currentConfig, input.configPatch);
    const nextVersion = located.entry.version + 1;
    const updatedAt = nowSeconds();
    const nextPayload: VisualizationConfig = {
      ...raw,
      config: nextConfig,
      version: nextVersion,
    } as VisualizationConfig;
    fs.writeFileSync(filePath, `${JSON.stringify(nextPayload, null, 2)}\n`, "utf8");

    const entries = this.readSessionEntries(located.sessionId).map((entry) =>
      entry.artifact_id === input.artifactId
        ? {
            ...entry,
            version: nextVersion,
            updated_at: updatedAt,
          }
        : entry,
    );
    this.writeSessionEntries(located.sessionId, entries);
    return {
      artifact_id: located.entry.artifact_id,
      viz_type: located.entry.viz_type,
      sub_type: located.entry.sub_type,
      title: located.entry.title,
      version: nextVersion,
      file_path: filePath,
      session_id: located.entry.session_id,
      created_at: located.entry.created_at,
      updated_at: updatedAt,
    };
  }

  deleteVisualization(artifactId: string): boolean {
    const located = this.findVisualizationWithSession(artifactId);
    if (!located) {
      return false;
    }

    this.deleteManagedFileIfPresent(located.entry.file_path);
    const remaining = this.readSessionEntries(located.sessionId).filter(
      (entry) => entry.artifact_id !== artifactId,
    );
    this.writeSessionEntries(located.sessionId, remaining);
    return true;
  }

  deleteSessionVisualizations(sessionId: string): number {
    const entries = this.readSessionEntries(sessionId);
    for (const entry of entries) {
      this.deleteManagedFileIfPresent(entry.file_path);
    }
    this.writeSessionEntries(sessionId, []);
    return entries.length;
  }

  private findVisualization(artifactId: string): VisualizationIndexEntry | null {
    return this.findVisualizationWithSession(artifactId)?.entry ?? null;
  }

  private findVisualizationWithSession(
    artifactId: string,
  ): { sessionId: string; entry: VisualizationIndexEntry } | null {
    for (const sessionId of this.listSessionIds()) {
      const entry = this.readSessionEntries(sessionId).find((item) => item.artifact_id === artifactId);
      if (entry) {
        return { sessionId, entry };
      }
    }
    return null;
  }

  private createVisualization(input: {
    sessionId: string | null | undefined;
    vizType: "chart" | "map";
    subType: string;
    title: string;
    config: JsonValue;
  }): VisualizationRecord {
    const sessionId = normalizeString(input.sessionId);
    if (!sessionId) {
      throw new ArtifactServiceError("创建可视化 artifact 需要 session_id");
    }
    const artifactId = `viz_${randomId()}`;
    const now = nowSeconds();
    const root = path.join(this.sessionsRoot, sessionId, "visualizations");
    fs.mkdirSync(root, { recursive: true });
    const filePath = path.join(root, `${artifactId}.json`);
    const payload: VisualizationConfig = {
      artifact_id: artifactId,
      viz_type: input.vizType,
      sub_type: input.subType,
      title: input.title,
      version: 1,
      config: input.config,
    } as VisualizationConfig;
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    const entry: VisualizationIndexEntry = {
      artifact_id: artifactId,
      viz_type: input.vizType,
      sub_type: input.subType,
      title: input.title,
      version: 1,
      file_path: filePath,
      artifact_type: "json",
      mime_type: "application/json",
      session_id: sessionId,
      created_at: now,
      updated_at: now,
    };
    fs.appendFileSync(this.indexPath(sessionId), `${JSON.stringify(entry)}\n`, "utf8");
    return {
      artifact_id: artifactId,
      viz_type: entry.viz_type,
      sub_type: entry.sub_type,
      title: entry.title,
      version: entry.version,
      file_path: filePath,
      session_id: sessionId,
      created_at: now,
      updated_at: now,
    };
  }

  private listSessionIds(): string[] {
    try {
      return fs
        .readdirSync(this.sessionsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private readSessionEntries(sessionId: string): VisualizationIndexEntry[] {
    const indexPath = this.indexPath(sessionId);
    try {
      const lines = fs.readFileSync(indexPath, "utf8").split(/\r?\n/);
      const entries = lines
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => safeParseJson(line))
        .filter((value): value is Record<string, unknown> => isRecord(value))
        .map((value) => normalizeIndexEntry(value))
        .filter((value): value is VisualizationIndexEntry => value !== null)
        .filter((entry) => this.managedFileExists(entry.file_path));
      return dedupeByArtifactId(entries);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private writeSessionEntries(sessionId: string, entries: VisualizationIndexEntry[]): void {
    const indexPath = this.indexPath(sessionId);
    if (entries.length === 0) {
      try {
        fs.unlinkSync(indexPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      return;
    }

    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  }

  private indexPath(sessionId: string): string {
    return path.join(this.sessionsRoot, sessionId, "visualizations", "viz_index.jsonl");
  }

  private resolveManagedFile(filePath: string): string {
    const resolved = path.resolve(filePath);
    if (!isPathUnder(resolved, this.dataRoot)) {
      throw new ArtifactServiceError("artifact 路径不在托管数据目录内", 404);
    }
    return resolved;
  }

  private managedFileExists(filePath: string): boolean {
    try {
      return fs.statSync(this.resolveManagedFile(filePath)).isFile();
    } catch {
      return false;
    }
  }

  private deleteManagedFileIfPresent(filePath: string): void {
    try {
      const resolved = this.resolveManagedFile(filePath);
      if (fs.existsSync(resolved)) {
        fs.unlinkSync(resolved);
      }
    } catch (error) {
      if (error instanceof ArtifactServiceError) {
        return;
      }
      throw error;
    }
  }
}

function dedupeByArtifactId(entries: VisualizationIndexEntry[]): VisualizationIndexEntry[] {
  const byId = new Map<string, VisualizationIndexEntry>();
  for (const entry of entries) {
    byId.set(entry.artifact_id, entry);
  }
  return Array.from(byId.values());
}

function normalizeIndexEntry(value: Record<string, unknown>): VisualizationIndexEntry | null {
  const artifactId = asString(value.artifact_id);
  const filePath = asString(value.file_path);
  if (!artifactId || !filePath) {
    return null;
  }
  return {
    artifact_id: artifactId,
    viz_type: asString(value.viz_type) || "chart",
    sub_type: asString(value.sub_type),
    title: asString(value.title),
    version: asNumber(value.version) ?? 1,
    file_path: filePath,
    artifact_type: asString(value.artifact_type) || "json",
    mime_type: value.mime_type === null ? null : asString(value.mime_type) || null,
    session_id: value.session_id === null ? null : asString(value.session_id) || null,
    created_at: asNumber(value.created_at) ?? 0,
    updated_at: asNumber(value.updated_at) ?? 0,
  };
}



function nowSeconds(): number {
  return Date.now() / 1000;
}

function randomId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 10);
}

function deepMergeJson(current: unknown, patch: unknown): JsonValue {
  if (!isRecord(current) || !isRecord(patch)) {
    return toJsonValue(patch);
  }
  const merged: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(current)) {
    merged[key] = toJsonValue(value);
  }
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = deepMergeJson(merged[key], value);
  }
  return merged;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = toJsonValue(item);
    }
    return result;
  }
  return null;
}

function safeParseJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}



function isPathUnder(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
