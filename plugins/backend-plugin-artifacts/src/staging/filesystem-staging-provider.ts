import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  ArtifactStagedFile,
  ArtifactStagingClaim,
  ArtifactStagingClaimContext,
  ArtifactStagingOutputInput,
  ArtifactStagingProvider,
  ArtifactStagingRun,
  ArtifactStagingRunContext,
  ArtifactStagingService,
} from "./contracts.js";

const STAGING_SCHEMA_VERSION = 1;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_RUN_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_FILES = 64;
const STAGE_RUN_PATTERN = /^stage_run_[a-f0-9]{24}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

interface StagingFileRecord {
  staged_file_id: string;
  relative_path: string;
  filename: string;
  media_type: string | null;
  size: number;
  sha256: string;
  state: "ready" | "claimed";
  claim_id: string | null;
}

interface StagingManifest {
  schema_version: 1;
  stage_run_id: string;
  tenant_id: string;
  session_id: string;
  run_id: string | null;
  tool_call_id: string | null;
  state: "writing" | "ready" | "claimed";
  created_at: string;
  expires_at: string;
  files: StagingFileRecord[];
}

interface IndexedFile {
  service: FilesystemArtifactStagingService;
  stageRunId: string;
}

interface IndexedClaim extends IndexedFile {
  stagedFileId: string;
}

export interface FilesystemArtifactStagingOptions {
  ttlMs?: number;
  maxFileBytes?: number;
  maxRunBytes?: number;
  maxFiles?: number;
}

export class FilesystemArtifactStagingProvider implements ArtifactStagingProvider {
  private readonly services = new Map<string, FilesystemArtifactStagingService>();
  private readonly files = new Map<string, IndexedFile>();
  private readonly claims = new Map<string, IndexedClaim>();

  constructor(private readonly options: FilesystemArtifactStagingOptions = {}) {}

  forTenant(tenantId: string, dataRoot: string): ArtifactStagingService {
    const normalizedTenantId = requiredString(tenantId, "tenantId");
    const normalizedDataRoot = path.resolve(requiredString(dataRoot, "dataRoot"));
    const current = this.services.get(normalizedTenantId);
    if (current) {
      if (current.dataRoot !== normalizedDataRoot) {
        throw new Error(`Artifact staging tenant '${normalizedTenantId}' 已绑定到其他 dataRoot`);
      }
      return current;
    }
    const service = new FilesystemArtifactStagingService({
      tenantId: normalizedTenantId,
      dataRoot: normalizedDataRoot,
      ttlMs: positiveOption(this.options.ttlMs, DEFAULT_TTL_MS, "ttlMs"),
      maxFileBytes: positiveOption(this.options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, "maxFileBytes"),
      maxRunBytes: positiveOption(this.options.maxRunBytes, DEFAULT_MAX_RUN_BYTES, "maxRunBytes"),
      maxFiles: positiveOption(this.options.maxFiles, DEFAULT_MAX_FILES, "maxFiles"),
      onFilesRegistered: (stageRunId, files) => {
        for (const file of files) this.files.set(file.stagedFileId, { service, stageRunId });
      },
      onRunRemoved: (stageRunId) => this.removeRunIndexes(service, stageRunId),
    });
    this.services.set(normalizedTenantId, service);
    void service.cleanupExpired().catch(() => undefined);
    return service;
  }

  async claimFiles(context: ArtifactStagingClaimContext): Promise<readonly ArtifactStagingClaim[]> {
    if (!context.stagedFileIds.length) return [];
    const uniqueIds = new Set(context.stagedFileIds);
    if (uniqueIds.size !== context.stagedFileIds.length) throw new Error("staged_file_id 不能重复");
    const grouped = new Map<FilesystemArtifactStagingService, string[]>();
    for (const stagedFileId of context.stagedFileIds) {
      const indexed = this.files.get(stagedFileId);
      if (!indexed) throw new Error(`staged file 不存在或已过期: ${stagedFileId}`);
      const ids = grouped.get(indexed.service) ?? [];
      ids.push(stagedFileId);
      grouped.set(indexed.service, ids);
    }
    const claimed: ArtifactStagingClaim[] = [];
    try {
      for (const [service, stagedFileIds] of grouped) {
        const batch = await service.claimFiles({ ...context, stagedFileIds });
        for (const claim of batch) {
          const indexed = this.files.get(claim.stagedFileId);
          if (!indexed) throw new Error(`staged file 索引丢失: ${claim.stagedFileId}`);
          this.claims.set(claim.claimId, { ...indexed, stagedFileId: claim.stagedFileId });
          claimed.push(claim);
        }
      }
      return claimed;
    } catch (error) {
      await this.rollbackClaims(claimed).catch(() => undefined);
      throw error;
    }
  }

  async commitClaims(claims: readonly ArtifactStagingClaim[]): Promise<void> {
    await this.finishClaims(claims, "commit");
  }

  async rollbackClaims(claims: readonly ArtifactStagingClaim[]): Promise<void> {
    await this.finishClaims(claims, "rollback");
  }

  async cleanupExpired(): Promise<number> {
    let removed = 0;
    for (const service of this.services.values()) removed += await service.cleanupExpired();
    return removed;
  }

  private async finishClaims(
    claims: readonly ArtifactStagingClaim[],
    operation: "commit" | "rollback",
  ): Promise<void> {
    const grouped = new Map<FilesystemArtifactStagingService, ArtifactStagingClaim[]>();
    for (const claim of claims) {
      const indexed = this.claims.get(claim.claimId);
      if (!indexed || indexed.stagedFileId !== claim.stagedFileId) {
        throw new Error(`staging claim 不存在: ${claim.claimId}`);
      }
      const values = grouped.get(indexed.service) ?? [];
      values.push(claim);
      grouped.set(indexed.service, values);
    }
    for (const [service, values] of grouped) {
      if (operation === "commit") await service.commitClaims(values);
      else await service.rollbackClaims(values);
      for (const value of values) this.claims.delete(value.claimId);
    }
  }

  private removeRunIndexes(service: FilesystemArtifactStagingService, stageRunId: string): void {
    for (const [stagedFileId, indexed] of this.files) {
      if (indexed.service === service && indexed.stageRunId === stageRunId) this.files.delete(stagedFileId);
    }
    for (const [claimId, indexed] of this.claims) {
      if (indexed.service === service && indexed.stageRunId === stageRunId) this.claims.delete(claimId);
    }
  }
}

interface FilesystemArtifactStagingServiceOptions {
  tenantId: string;
  dataRoot: string;
  ttlMs: number;
  maxFileBytes: number;
  maxRunBytes: number;
  maxFiles: number;
  onFilesRegistered(stageRunId: string, files: readonly ArtifactStagedFile[]): void;
  onRunRemoved(stageRunId: string): void;
}

class FilesystemArtifactStagingService implements ArtifactStagingService {
  readonly dataRoot: string;
  private readonly stagingRoot: string;

  constructor(private readonly options: FilesystemArtifactStagingServiceOptions) {
    this.dataRoot = options.dataRoot;
    this.stagingRoot = path.join(this.dataRoot, "staging", "artifacts");
  }

  async createRun(context: ArtifactStagingRunContext): Promise<ArtifactStagingRun> {
    await this.cleanupExpired();
    const stageRunId = `stage_run_${randomToken()}`;
    const runRoot = this.runRoot(stageRunId);
    const outputDirectory = path.join(runRoot, "output");
    fs.mkdirSync(outputDirectory, { recursive: true });
    const now = Date.now();
    this.writeManifest({
      schema_version: STAGING_SCHEMA_VERSION,
      stage_run_id: stageRunId,
      tenant_id: this.options.tenantId,
      session_id: requiredString(context.sessionId, "sessionId"),
      run_id: nullableString(context.runId),
      tool_call_id: nullableString(context.toolCallId),
      state: "writing",
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + this.options.ttlMs).toISOString(),
      files: [],
    });
    return { stageRunId, outputDirectory };
  }

  async registerOutputs(
    stageRunId: string,
    outputs: readonly ArtifactStagingOutputInput[],
  ): Promise<readonly ArtifactStagedFile[]> {
    const manifest = this.readManifest(stageRunId);
    if (manifest.state !== "writing") throw new Error(`staging run 不能登记输出: ${manifest.state}`);
    if (!outputs.length) throw new Error("staging outputs 不能为空");
    if (outputs.length > this.options.maxFiles) throw new Error(`staging run 最多允许 ${this.options.maxFiles} 个文件`);
    const normalizedPaths = outputs.map((output) => normalizeRelativePath(output.relativePath));
    if (new Set(normalizedPaths).size !== normalizedPaths.length) throw new Error("staging 输出路径不能重复");
    const files: StagingFileRecord[] = [];
    let totalBytes = 0;
    for (let index = 0; index < outputs.length; index += 1) {
      const input = outputs[index]!;
      const relativePath = normalizedPaths[index]!;
      const source = this.requireRegularOutput(stageRunId, relativePath);
      const stat = fs.statSync(source);
      if (!stat.size) throw new Error(`staging 输出不能为空: ${relativePath}`);
      if (stat.size > this.options.maxFileBytes) {
        throw new Error(`staging 文件不能超过 ${this.options.maxFileBytes} 字节: ${relativePath}`);
      }
      totalBytes += stat.size;
      if (totalBytes > this.options.maxRunBytes) {
        throw new Error(`staging run 总大小不能超过 ${this.options.maxRunBytes} 字节`);
      }
      files.push({
        staged_file_id: `stage_${randomToken()}`,
        relative_path: relativePath,
        filename: safeFilename(input.filename, relativePath),
        media_type: nullableString(input.mediaType),
        size: stat.size,
        sha256: await hashFile(source),
        state: "ready",
        claim_id: null,
      });
    }
    manifest.files = files;
    manifest.state = "ready";
    this.writeManifest(manifest);
    const registered = files.map(toStagedFile);
    this.options.onFilesRegistered(stageRunId, registered);
    return registered;
  }

  async discardRun(stageRunId: string): Promise<void> {
    const runRoot = this.runRoot(stageRunId);
    fs.rmSync(runRoot, { recursive: true, force: true });
    this.options.onRunRemoved(stageRunId);
  }

  async claimFiles(context: ArtifactStagingClaimContext): Promise<readonly ArtifactStagingClaim[]> {
    const locations = context.stagedFileIds.map((stagedFileId) => this.findFile(stagedFileId));
    const stageRunIds = new Set(locations.map((item) => item.stageRunId));
    if (stageRunIds.size !== 1) throw new Error("一次 claim 只能接管同一个 staging run 的文件");
    const stageRunId = locations[0]!.stageRunId;
    const manifest = this.readManifest(stageRunId);
    this.assertOwner(manifest, context);
    if (manifest.state !== "ready") throw new Error(`staging run 当前不可接管: ${manifest.state}`);
    const requested = new Set(context.stagedFileIds);
    if (requested.size !== manifest.files.length || manifest.files.some((file) => !requested.has(file.staged_file_id))) {
      throw new Error("必须一次接管 staging run 登记的全部文件");
    }
    const claims: ArtifactStagingClaim[] = [];
    for (const file of manifest.files) {
      const sourcePath = this.requireRegularOutput(stageRunId, file.relative_path);
      const stat = fs.statSync(sourcePath);
      const sha256 = await hashFile(sourcePath);
      if (stat.size !== file.size || sha256 !== file.sha256) {
        throw new Error(`staging 文件登记后发生变化: ${file.staged_file_id}`);
      }
      const claimId = `claim_${randomToken()}`;
      file.state = "claimed";
      file.claim_id = claimId;
      claims.push({ ...toStagedFile(file), claimId, sourcePath });
    }
    manifest.state = "claimed";
    this.writeManifest(manifest);
    return claims;
  }

  async commitClaims(claims: readonly ArtifactStagingClaim[]): Promise<void> {
    const manifest = this.requireClaimBatch(claims);
    await this.discardRun(manifest.stage_run_id);
  }

  async rollbackClaims(claims: readonly ArtifactStagingClaim[]): Promise<void> {
    const manifest = this.requireClaimBatch(claims);
    for (const file of manifest.files) {
      file.state = "ready";
      file.claim_id = null;
    }
    manifest.state = "ready";
    this.writeManifest(manifest);
  }

  async cleanupExpired(): Promise<number> {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(this.stagingRoot, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let removed = 0;
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory() || !STAGE_RUN_PATTERN.test(entry.name)) continue;
      let expiresAt = 0;
      try { expiresAt = Date.parse(this.readManifest(entry.name).expires_at); }
      catch { expiresAt = 0; }
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        await this.discardRun(entry.name);
        removed += 1;
      }
    }
    return removed;
  }

  private findFile(stagedFileId: string): { stageRunId: string; file: StagingFileRecord } {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(this.stagingRoot, { withFileTypes: true }); }
    catch { throw new Error(`staged file 不存在: ${stagedFileId}`); }
    for (const entry of entries) {
      if (!entry.isDirectory() || !STAGE_RUN_PATTERN.test(entry.name)) continue;
      const manifest = this.readManifest(entry.name);
      const file = manifest.files.find((item) => item.staged_file_id === stagedFileId);
      if (file) return { stageRunId: entry.name, file };
    }
    throw new Error(`staged file 不存在: ${stagedFileId}`);
  }

  private requireClaimBatch(claims: readonly ArtifactStagingClaim[]): StagingManifest {
    if (!claims.length) throw new Error("staging claims 不能为空");
    const location = this.findFile(claims[0]!.stagedFileId);
    const manifest = this.readManifest(location.stageRunId);
    if (manifest.state !== "claimed" || claims.length !== manifest.files.length) {
      throw new Error("staging claim 批次不完整");
    }
    const claimByFile = new Map(claims.map((claim) => [claim.stagedFileId, claim.claimId]));
    for (const file of manifest.files) {
      if (file.state !== "claimed" || file.claim_id !== claimByFile.get(file.staged_file_id)) {
        throw new Error(`staging claim 不匹配: ${file.staged_file_id}`);
      }
    }
    return manifest;
  }

  private assertOwner(manifest: StagingManifest, context: ArtifactStagingClaimContext): void {
    if (manifest.tenant_id !== context.tenantId) throw new Error("不能接管其他 tenant 的 staged file");
    if (manifest.session_id !== context.sessionId) throw new Error("不能接管其他 session 的 staged file");
    if (manifest.run_id !== nullableString(context.runId)) throw new Error("不能接管其他 run 的 staged file");
    if (manifest.tool_call_id !== nullableString(context.toolCallId)) throw new Error("不能接管其他 tool call 的 staged file");
    if (Date.parse(manifest.expires_at) <= Date.now()) throw new Error("staged file 已过期");
  }

  private requireRegularOutput(stageRunId: string, relativePath: string): string {
    const outputRoot = path.join(this.runRoot(stageRunId), "output");
    const candidate = path.resolve(outputRoot, relativePath);
    if (!isPathUnder(candidate, outputRoot)) throw new Error(`staging 输出路径越界: ${relativePath}`);
    let lstat: fs.Stats;
    try { lstat = fs.lstatSync(candidate); }
    catch { throw new Error(`staging 输出不存在: ${relativePath}`); }
    if (lstat.isSymbolicLink() || !lstat.isFile()) throw new Error(`staging 输出必须是普通文件: ${relativePath}`);
    const realRoot = fs.realpathSync(outputRoot);
    const realCandidate = fs.realpathSync(candidate);
    if (!isPathUnder(realCandidate, realRoot)) throw new Error(`staging 输出路径越界: ${relativePath}`);
    return candidate;
  }

  private runRoot(stageRunId: string): string {
    if (!STAGE_RUN_PATTERN.test(stageRunId)) throw new Error("stageRunId 格式无效");
    const resolved = path.resolve(this.stagingRoot, stageRunId);
    if (!isPathUnder(resolved, this.stagingRoot)) throw new Error("staging run 路径越界");
    return resolved;
  }

  private manifestPath(stageRunId: string): string {
    return path.join(this.runRoot(stageRunId), "stage.json");
  }

  private readManifest(stageRunId: string): StagingManifest {
    let value: unknown;
    try { value = JSON.parse(fs.readFileSync(this.manifestPath(stageRunId), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`staging run 不存在: ${stageRunId}`);
      throw new Error(`staging manifest 无效: ${stageRunId}`);
    }
    if (!isStagingManifest(value) || value.stage_run_id !== stageRunId || value.tenant_id !== this.options.tenantId) {
      throw new Error(`staging manifest 无效: ${stageRunId}`);
    }
    return value;
  }

  private writeManifest(manifest: StagingManifest): void {
    const target = this.manifestPath(manifest.stage_run_id);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${randomUUID()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    try { fs.renameSync(temporary, target); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTEMPTY") {
        try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
        throw error;
      }
      fs.rmSync(target, { force: true });
      fs.renameSync(temporary, target);
    }
  }
}

export function createFilesystemArtifactStagingProvider(
  options: FilesystemArtifactStagingOptions = {},
): ArtifactStagingProvider {
  return new FilesystemArtifactStagingProvider(options);
}

function toStagedFile(file: StagingFileRecord): ArtifactStagedFile {
  return {
    stagedFileId: file.staged_file_id,
    filename: file.filename,
    mediaType: file.media_type,
    size: file.size,
    sha256: file.sha256,
  };
}

function normalizeRelativePath(value: string): string {
  const normalized = requiredString(value, "relativePath").replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//u.test(normalized)) throw new Error("staging 输出路径必须是相对路径");
  const clean = path.posix.normalize(normalized);
  if (clean === "." || clean === ".." || clean.startsWith("../") || clean.includes("\0")) {
    throw new Error("staging 输出路径无效");
  }
  return clean;
}

function safeFilename(value: string | null | undefined, relativePath: string): string {
  const filename = typeof value === "string" ? path.basename(value.trim()) : path.basename(relativePath);
  if (!filename || filename === "." || filename === "..") throw new Error("staging filename 无效");
  return filename.slice(0, 255);
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function randomToken(): string {
  return randomUUID().replaceAll("-", "").slice(0, 24);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 不能为空`);
  return value.trim();
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveOption(value: number | undefined, fallback: number, field: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new Error(`${field} 必须是正整数`);
  return normalized;
}

function isStagingManifest(value: unknown): value is StagingManifest {
  if (!isRecord(value) || value.schema_version !== STAGING_SCHEMA_VERSION) return false;
  if (typeof value.stage_run_id !== "string" || !STAGE_RUN_PATTERN.test(value.stage_run_id)) return false;
  if (typeof value.tenant_id !== "string" || typeof value.session_id !== "string") return false;
  if (value.run_id !== null && typeof value.run_id !== "string") return false;
  if (value.tool_call_id !== null && typeof value.tool_call_id !== "string") return false;
  if (value.state !== "writing" && value.state !== "ready" && value.state !== "claimed") return false;
  if (typeof value.created_at !== "string" || typeof value.expires_at !== "string" || !Array.isArray(value.files)) return false;
  return value.files.every((file) => isRecord(file)
    && typeof file.staged_file_id === "string"
    && typeof file.relative_path === "string"
    && typeof file.filename === "string"
    && (file.media_type === null || typeof file.media_type === "string")
    && Number.isSafeInteger(file.size) && Number(file.size) > 0
    && typeof file.sha256 === "string" && SHA256_PATTERN.test(file.sha256)
    && (file.state === "ready" || file.state === "claimed")
    && (file.claim_id === null || typeof file.claim_id === "string"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPathUnder(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
