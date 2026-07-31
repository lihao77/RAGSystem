import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ArtifactServiceError } from "../../artifact-error.js";
import {
  assetContentUrl,
  normalizeCreateInput,
  parseArtifactManifest,
  reviseManifest,
  storedAssetFilename,
} from "../../artifact-model.js";
import type {
  ArtifactAssetContent,
  ArtifactCreateInput,
  ArtifactRecord,
  ArtifactRevisionInput,
} from "../../contracts/artifact-application.js";
import type {
  ArtifactAsset,
  ArtifactIndexEntry,
  ArtifactManifest,
  ArtifactStatus,
  ArtifactSummary,
} from "../../contracts/artifacts.js";

const INDEX_FILENAME = "artifact_index.v2.jsonl";

export class FilesystemArtifactService {
  private readonly dataRoot: string;
  private readonly sessionsRoot: string;

  constructor(options: { dataRoot?: string }) {
    if (!options.dataRoot?.trim()) throw new Error("FilesystemArtifactService 必须传入已解析的 dataRoot");
    this.dataRoot = path.resolve(options.dataRoot);
    this.sessionsRoot = path.join(this.dataRoot, "sessions");
  }

  getArtifact(artifactId: string): ArtifactManifest {
    const located = this.requireEntry(artifactId);
    const manifest = this.readManifest(located.entry.manifest_path);
    if (manifest.artifact_id !== artifactId || manifest.session_id !== located.sessionId) {
      throw new ArtifactServiceError(`artifact manifest 与索引不一致: ${artifactId}`, 500);
    }
    return manifest;
  }

  getArtifactAsset(artifactId: string, assetId: string): ArtifactAssetContent {
    const located = this.requireEntry(artifactId);
    const manifest = this.readManifest(located.entry.manifest_path);
    const asset = manifest.assets.find((item) => item.asset_id === assetId);
    if (!asset) throw new ArtifactServiceError(`artifact asset 不存在: ${artifactId}/${assetId}`, 404);
    const assetPath = path.join(path.dirname(this.resolveManagedFile(located.entry.manifest_path)), "assets", storedAssetFilename(asset.asset_id, asset.filename));
    let body: Buffer;
    try { body = fs.readFileSync(this.resolveManagedFile(assetPath)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ArtifactServiceError(`artifact asset 内容不存在: ${artifactId}/${assetId}`, 404);
      throw error;
    }
    return { body, mediaType: asset.media_type, filename: asset.filename, sha256: asset.sha256 };
  }

  listArtifacts(sessionId: string): ArtifactSummary[] {
    return this.readSessionEntries(sessionId).map(summary);
  }

  getArtifactSessionId(artifactId: string): string | null {
    return this.findEntry(artifactId)?.sessionId ?? null;
  }

  createArtifact(input: ArtifactCreateInput): ArtifactRecord {
    const normalized = normalizeCreateInput(input);
    const artifactId = `art_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const now = new Date().toISOString();
    const artifactsRoot = this.artifactsRoot(normalized.sessionId);
    const finalRoot = path.join(artifactsRoot, artifactId);
    const stagingRoot = path.join(artifactsRoot, `.tmp-${artifactId}-${randomUUID()}`);
    const manifestPath = path.join(finalRoot, "manifest.json");
    fs.mkdirSync(path.join(stagingRoot, "assets"), { recursive: true });
    try {
      const assets: ArtifactAsset[] = normalized.assets.map((asset) => {
        const filename = asset.filename as string;
        fs.writeFileSync(path.join(stagingRoot, "assets", storedAssetFilename(asset.assetId, filename)), asset.body);
        return {
          asset_id: asset.assetId,
          role: asset.role,
          filename,
          media_type: asset.mediaType,
          size: asset.body.byteLength,
          sha256: createHash("sha256").update(asset.body).digest("hex"),
          content_url: assetContentUrl(artifactId, asset.assetId),
        };
      });
      const manifest: ArtifactManifest = {
        schema_version: 2,
        artifact_id: artifactId,
        revision: 1,
        session_id: normalized.sessionId,
        kind: normalized.kind,
        subtype: normalized.subtype,
        title: normalized.title,
        status: normalized.status,
        assets,
        presentations: normalized.presentations,
        metadata: normalized.metadata,
        provenance: normalized.provenance,
        relations: normalized.relations,
        created_at: now,
        updated_at: now,
      };
      writeJson(path.join(stagingRoot, "manifest.json"), manifest);
      fs.renameSync(stagingRoot, finalRoot);
      const entry = indexEntry(manifest, manifestPath);
      try {
        this.writeSessionEntries(normalized.sessionId, [...this.readSessionEntries(normalized.sessionId), entry]);
      } catch (error) {
        this.deleteManagedDirectory(finalRoot);
        throw error;
      }
      return record(entry);
    } catch (error) {
      this.deleteManagedDirectory(stagingRoot);
      throw error;
    }
  }

  reviseArtifact(input: ArtifactRevisionInput): ArtifactRecord {
    const located = this.requireEntry(input.artifactId);
    const manifestPath = this.resolveManagedFile(located.entry.manifest_path);
    const next = reviseManifest(this.readManifest(manifestPath), input, new Date().toISOString());
    writeJsonAtomic(manifestPath, next);
    const nextEntry = indexEntry(next, manifestPath);
    this.writeSessionEntries(located.sessionId, this.readSessionEntries(located.sessionId).map((entry) => entry.artifact_id === input.artifactId ? nextEntry : entry));
    return record(nextEntry);
  }

  deleteArtifact(artifactId: string): boolean {
    const located = this.findEntry(artifactId);
    if (!located) return false;
    this.deleteManagedDirectory(path.dirname(located.entry.manifest_path));
    this.writeSessionEntries(located.sessionId, this.readSessionEntries(located.sessionId).filter((entry) => entry.artifact_id !== artifactId));
    return true;
  }

  deleteSessionArtifacts(sessionId: string): number {
    const entries = this.readSessionEntries(sessionId);
    for (const entry of entries) this.deleteManagedDirectory(path.dirname(entry.manifest_path));
    this.writeSessionEntries(sessionId, []);
    return entries.length;
  }

  private requireEntry(artifactId: string): { sessionId: string; entry: ArtifactIndexEntry } {
    const located = this.findEntry(artifactId);
    if (!located) throw new ArtifactServiceError(`未找到 artifact: ${artifactId}`, 404);
    return located;
  }

  private findEntry(artifactId: string): { sessionId: string; entry: ArtifactIndexEntry } | null {
    for (const indexPath of this.listIndexPaths()) {
      const entry = this.readEntries(indexPath).find((item) => item.artifact_id === artifactId);
      if (entry) return { sessionId: entry.session_id, entry };
    }
    return null;
  }

  private listIndexPaths(): string[] {
    try {
      return fs.readdirSync(this.sessionsRoot, { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .map((item) => path.join(this.sessionsRoot, item.name, "artifacts", INDEX_FILENAME))
        .filter((item) => fs.existsSync(item));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private readSessionEntries(sessionId: string): ArtifactIndexEntry[] {
    return this.readEntries(this.indexPath(sessionId));
  }

  private readEntries(indexPath: string): ArtifactIndexEntry[] {
    try {
      const entries = fs.readFileSync(indexPath, "utf8")
        .split(/\r?\n/u)
        .filter(Boolean)
        .map(parseIndexEntry)
        .filter((entry): entry is ArtifactIndexEntry => entry !== null);
      return Array.from(new Map(entries.map((entry) => [entry.artifact_id, entry])).values())
        .filter((entry) => this.managedFileExists(entry.manifest_path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private writeSessionEntries(sessionId: string, entries: ArtifactIndexEntry[]): void {
    const indexPath = this.indexPath(sessionId);
    if (!entries.length) {
      try { fs.unlinkSync(indexPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      return;
    }
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    const content = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    writeTextAtomic(indexPath, content);
  }

  private artifactsRoot(sessionId: string): string {
    return path.join(this.sessionsRoot, encodeURIComponent(sessionId), "artifacts");
  }

  private indexPath(sessionId: string): string {
    return path.join(this.artifactsRoot(sessionId), INDEX_FILENAME);
  }

  private resolveManagedFile(filePath: string): string {
    const resolved = path.resolve(filePath);
    if (!isPathUnder(resolved, this.dataRoot)) throw new ArtifactServiceError("artifact 路径不在托管数据目录内", 404);
    return resolved;
  }

  private managedFileExists(filePath: string): boolean {
    try { return fs.statSync(this.resolveManagedFile(filePath)).isFile(); }
    catch { return false; }
  }

  private deleteManagedDirectory(directory: string): void {
    const resolved = this.resolveManagedFile(directory);
    if (resolved === this.dataRoot || resolved === this.sessionsRoot) throw new ArtifactServiceError("拒绝删除 artifact 根目录", 500);
    fs.rmSync(resolved, { recursive: true, force: true });
  }

  private readManifest(filePath: string): ArtifactManifest {
    let value: unknown;
    try { value = JSON.parse(fs.readFileSync(this.resolveManagedFile(filePath), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ArtifactServiceError("artifact manifest 不存在", 404);
      if (error instanceof SyntaxError) throw new ArtifactServiceError("artifact manifest JSON 无效", 500);
      throw error;
    }
    return parseArtifactManifest(value);
  }
}

function indexEntry(manifest: ArtifactManifest, manifestPath: string): ArtifactIndexEntry {
  return {
    schema_version: 2,
    artifact_id: manifest.artifact_id,
    session_id: manifest.session_id,
    kind: manifest.kind,
    subtype: manifest.subtype,
    title: manifest.title,
    status: manifest.status,
    revision: manifest.revision,
    manifest_path: manifestPath,
    asset_count: manifest.assets.length,
    presentation_count: manifest.presentations.length,
    created_at: manifest.created_at,
    updated_at: manifest.updated_at,
  };
}

function record(entry: ArtifactIndexEntry): ArtifactRecord {
  return { ...entry };
}

function summary(entry: ArtifactIndexEntry): ArtifactSummary {
  const { manifest_path: _manifestPath, ...rest } = entry;
  return rest;
}

function parseIndexEntry(line: string): ArtifactIndexEntry | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!isRecord(value) || value.schema_version !== 2 || typeof value.artifact_id !== "string" || typeof value.session_id !== "string" || typeof value.manifest_path !== "string") return null;
  if (typeof value.kind !== "string" || typeof value.subtype !== "string" || typeof value.title !== "string" || !isStatus(value.status)) return null;
  if (!positiveInteger(value.revision) || !nonNegativeInteger(value.asset_count) || !nonNegativeInteger(value.presentation_count)) return null;
  if (typeof value.created_at !== "string" || typeof value.updated_at !== "string") return null;
  return value as unknown as ArtifactIndexEntry;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextAtomic(filePath: string, content: string): void {
  const temporary = `${filePath}.tmp-${randomUUID()}`;
  fs.writeFileSync(temporary, content, "utf8");
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTEMPTY") {
      try { fs.unlinkSync(temporary); } catch { /* best effort */ }
      throw error;
    }
    fs.rmSync(filePath, { force: true });
    fs.renameSync(temporary, filePath);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is ArtifactStatus {
  return value === "ready" || value === "failed";
}

function positiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isPathUnder(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
