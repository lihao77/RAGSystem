import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { ArtifactAssetInput, ArtifactContent, ArtifactRecord } from "../../contracts/artifact-application.js";
import type { ArtifactDescriptor, ArtifactIndexEntry, ArtifactSummary } from "../../contracts/artifacts.js";
import type { JsonValue } from "../../contracts/json.js";
import { ArtifactServiceError } from "../../artifact-error.js";

export class FilesystemArtifactService {
  private readonly dataRoot: string;
  private readonly sessionsRoot: string;

  constructor(options: { dataRoot?: string }) {
    if (!options.dataRoot?.trim()) throw new Error("FilesystemArtifactService 必须传入已解析的 dataRoot");
    this.dataRoot = path.resolve(options.dataRoot);
    this.sessionsRoot = path.join(this.dataRoot, "sessions");
  }

  getArtifact(artifactId: string): ArtifactDescriptor {
    const located = this.requireEntry(artifactId);
    const parsed = this.readJson(located.entry.descriptor_path);
    if (parsed.artifact_id !== artifactId) throw new ArtifactServiceError(`artifact 配置无效: ${artifactId}`, 500);
    return {
      ...parsed,
      content_url: located.entry.asset_path ? `/api/artifacts/${encodeURIComponent(artifactId)}/content` : null,
    } as ArtifactDescriptor;
  }

  getArtifactContent(artifactId: string): ArtifactContent | null {
    const located = this.requireEntry(artifactId);
    if (!located.entry.asset_path) return null;
    const body = fs.readFileSync(this.resolveManagedFile(located.entry.asset_path));
    const descriptor = this.readJson(located.entry.descriptor_path);
    const asset: Record<string, unknown> = isRecord(descriptor.asset) ? descriptor.asset as Record<string, unknown> : {};
    return {
      body,
      mimeType: located.entry.mime_type ?? String(asset.mime_type ?? "application/octet-stream"),
      filename: typeof asset.filename === "string" ? asset.filename : null,
    };
  }

  listArtifacts(sessionId: string): ArtifactSummary[] {
    return this.readSessionEntries(sessionId).map((entry) => ({
      artifact_id: entry.artifact_id,
      viz_type: entry.viz_type,
      sub_type: entry.sub_type,
      title: entry.title,
      version: entry.version,
      artifact_type: entry.artifact_type,
      mime_type: entry.mime_type,
      has_content: Boolean(entry.asset_path),
      created_at: entry.created_at,
      updated_at: entry.updated_at,
    }));
  }

  getArtifactSessionId(artifactId: string): string | null {
    return this.findEntry(artifactId)?.sessionId ?? null;
  }

  createArtifact(input: {
    sessionId: string | null | undefined;
    vizType: string;
    subType?: string | null;
    title?: string | null;
    config?: JsonValue | null;
    asset?: ArtifactAssetInput | null;
  }): ArtifactRecord {
    const sessionId = requiredString(input.sessionId, "session_id");
    const vizType = requiredString(input.vizType, "viz_type");
    if (input.asset && (!input.asset.mimeType.trim() || input.asset.body.byteLength === 0)) throw new ArtifactServiceError("asset 必须包含非空 body 和 mimeType");
    const artifactId = `art_${randomId()}`;
    const now = nowSeconds();
    const root = path.join(this.sessionsRoot, sessionId, "artifacts");
    fs.mkdirSync(root, { recursive: true });
    const descriptorPath = path.join(root, `${artifactId}.json`);
    const assetPath = input.asset ? path.join(root, `${artifactId}.asset`) : null;
    if (assetPath && input.asset) fs.writeFileSync(assetPath, input.asset.body);
    const descriptor: ArtifactDescriptor = {
      artifact_id: artifactId,
      viz_type: vizType,
      sub_type: normalizeString(input.subType) ?? "default",
      title: normalizeString(input.title) ?? "",
      version: 1,
      artifact_type: input.asset ? "binary" : "json",
      mime_type: input.asset?.mimeType ?? "application/json",
      content_url: assetPath ? `/api/artifacts/${encodeURIComponent(artifactId)}/content` : null,
      ...(input.asset ? { asset: { filename: safeFilename(input.asset.filename), mime_type: input.asset.mimeType } } : {}),
      config: input.config ?? {},
    };
    fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
    const entry: ArtifactIndexEntry = {
      artifact_id: artifactId,
      viz_type: descriptor.viz_type,
      sub_type: descriptor.sub_type,
      title: descriptor.title,
      version: 1,
      descriptor_path: descriptorPath,
      asset_path: assetPath,
      artifact_type: descriptor.artifact_type,
      mime_type: descriptor.mime_type,
      session_id: sessionId,
      created_at: now,
      updated_at: now,
    };
    fs.appendFileSync(this.indexPath(sessionId), `${JSON.stringify(entry)}\n`, "utf8");
    return record(entry);
  }

  reviseArtifact(input: { artifactId: string; configPatch: JsonValue; replace?: boolean | null }): ArtifactRecord {
    const located = this.requireEntry(input.artifactId);
    const descriptor = this.readJson(located.entry.descriptor_path);
    const nextVersion = located.entry.version + 1;
    const currentConfig = descriptor.config ?? {};
    descriptor.config = input.replace ? toJsonValue(input.configPatch) : deepMerge(currentConfig, input.configPatch);
    descriptor.version = nextVersion;
    fs.writeFileSync(this.resolveManagedFile(located.entry.descriptor_path), `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
    const updatedAt = nowSeconds();
    this.writeSessionEntries(located.sessionId, this.readSessionEntries(located.sessionId).map((entry) => entry.artifact_id === input.artifactId ? { ...entry, version: nextVersion, updated_at: updatedAt } : entry));
    return record({ ...located.entry, version: nextVersion, updated_at: updatedAt });
  }

  deleteArtifact(artifactId: string): boolean {
    const located = this.findEntry(artifactId);
    if (!located) return false;
    this.deleteManagedFile(located.entry.descriptor_path);
    if (located.entry.asset_path) this.deleteManagedFile(located.entry.asset_path);
    this.writeSessionEntries(located.sessionId, this.readSessionEntries(located.sessionId).filter((entry) => entry.artifact_id !== artifactId));
    return true;
  }

  deleteSessionArtifacts(sessionId: string): number {
    const entries = this.readSessionEntries(sessionId);
    for (const entry of entries) {
      this.deleteManagedFile(entry.descriptor_path);
      if (entry.asset_path) this.deleteManagedFile(entry.asset_path);
    }
    this.writeSessionEntries(sessionId, []);
    return entries.length;
  }

  private requireEntry(artifactId: string): { sessionId: string; entry: ArtifactIndexEntry } {
    const located = this.findEntry(artifactId);
    if (!located) throw new ArtifactServiceError(`未找到 artifact: ${artifactId}`, 404);
    return located;
  }

  private findEntry(artifactId: string): { sessionId: string; entry: ArtifactIndexEntry } | null {
    for (const sessionId of this.listSessionIds()) {
      const entry = this.readSessionEntries(sessionId).find((item) => item.artifact_id === artifactId);
      if (entry) return { sessionId, entry };
    }
    return null;
  }

  private listSessionIds(): string[] {
    try { return fs.readdirSync(this.sessionsRoot, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  private readSessionEntries(sessionId: string): ArtifactIndexEntry[] {
    try {
      const entries = fs.readFileSync(this.indexPath(sessionId), "utf8").split(/\r?\n/u).filter(Boolean).map((line) => safeJson(line)).filter(isRecord).map(normalizeEntry).filter((entry): entry is ArtifactIndexEntry => entry !== null);
      return Array.from(new Map(entries.map((entry) => [entry.artifact_id, entry])).values()).filter((entry) => this.managedFileExists(entry.descriptor_path));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  private writeSessionEntries(sessionId: string, entries: ArtifactIndexEntry[]): void {
    const indexPath = this.indexPath(sessionId);
    if (!entries.length) { try { fs.unlinkSync(indexPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } return; }
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  }

  private indexPath(sessionId: string): string { return path.join(this.sessionsRoot, sessionId, "artifacts", "artifact_index.jsonl"); }
  private resolveManagedFile(filePath: string): string {
    const resolved = path.resolve(filePath);
    if (!isPathUnder(resolved, this.dataRoot)) throw new ArtifactServiceError("artifact 路径不在托管数据目录内", 404);
    return resolved;
  }
  private managedFileExists(filePath: string): boolean { try { return fs.statSync(this.resolveManagedFile(filePath)).isFile(); } catch { return false; } }
  private deleteManagedFile(filePath: string): void { try { fs.unlinkSync(this.resolveManagedFile(filePath)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  private readJson(filePath: string): ArtifactDescriptor {
    const value = safeJson(fs.readFileSync(this.resolveManagedFile(filePath), "utf8"));
    if (!isRecord(value)) throw new ArtifactServiceError("artifact descriptor 无效", 500);
    return value as unknown as ArtifactDescriptor;
  }
}

function record(entry: ArtifactIndexEntry): ArtifactRecord { return { ...entry }; }
function normalizeEntry(value: Record<string, unknown>): ArtifactIndexEntry | null {
  const artifactId = asString(value.artifact_id); const descriptorPath = asString(value.descriptor_path); const sessionId = asString(value.session_id);
  if (!artifactId || !descriptorPath || !sessionId) return null;
  return { artifact_id: artifactId, viz_type: asString(value.viz_type) || "generic", sub_type: asString(value.sub_type) || "default", title: asString(value.title), version: asNumber(value.version) ?? 1, descriptor_path: descriptorPath, asset_path: value.asset_path == null ? null : asString(value.asset_path) || null, artifact_type: value.artifact_type === "binary" ? "binary" : "json", mime_type: value.mime_type == null ? null : asString(value.mime_type) || null, session_id: sessionId, created_at: asNumber(value.created_at) ?? 0, updated_at: asNumber(value.updated_at) ?? 0 };
}
function safeJson(value: string): unknown { try { return JSON.parse(value) as unknown; } catch { return null; } }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function asString(value: unknown): string { return typeof value === "string" ? value : ""; }
function asNumber(value: unknown): number | null { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function normalizeString(value: unknown): string | null { const normalized = asString(value).trim(); return normalized || null; }
function requiredString(value: unknown, field: string): string { const normalized = normalizeString(value); if (!normalized) throw new ArtifactServiceError(`创建 artifact 需要 ${field}`); return normalized; }
function safeFilename(value: string | null | undefined): string | null { const normalized = normalizeString(value); return normalized ? path.basename(normalized).slice(0, 255) : null; }
function toJsonValue(value: unknown): JsonValue { if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value; if (Array.isArray(value)) return value.map(toJsonValue); if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonValue(item)])); return null; }
function deepMerge(current: unknown, patch: unknown): JsonValue { if (!isRecord(current) || !isRecord(patch)) return toJsonValue(patch); return Object.fromEntries(Object.entries({ ...current, ...patch }).map(([key, value]) => [key, key in current ? deepMerge(current[key], value) : toJsonValue(value)])); }
function nowSeconds(): number { return Date.now() / 1000; }
function randomId(): string { return randomUUID().replaceAll("-", "").slice(0, 12); }
function isPathUnder(candidate: string, root: string): boolean { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
