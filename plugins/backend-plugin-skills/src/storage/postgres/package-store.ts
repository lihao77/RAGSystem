import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { requireSkillPath, skillBundleRevision, validateSkillBundle } from "../../contracts/skills/skill-bundle.js";
import type {
  CreateSkillPackageBundleInput,
  ISkillPackageStore,
  SkillPackageFileNode,
  SkillPackageRecord,
  SkillPackageMetadata,
} from "../../contracts/skills/skill-package-store.js";
import type { ObjectStorage } from "@ragsystem/backend-core/contracts/storage/object-storage.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import {
  parseSkillMarkdown,
  serializeSkillMd,
} from "../../contracts/skills/skill-markdown.js";
import type { PostgresSkillPackageRepository, SkillPackageMetadataRow, SkillPackageFileRow } from "./package-repository.js";

/**
 * SaaS skill packages: Postgres metadata + object storage bytes.
 * Execution materializes packages into a content-addressed local cache under cacheRoot.
 * Durable source of truth is never tenants/<id>/skills on disk.
 */
export class SaaSSkillPackageStore implements ISkillPackageStore {
  private reclamation: Promise<void> | null = null;

  constructor(
    private readonly tenantId: TenantId,
    private readonly repository: PostgresSkillPackageRepository,
    private readonly objects: ObjectStorage,
    private readonly cacheRoot: string,
  ) {}

  async list(): Promise<SkillPackageRecord[]> {
    const records = await Promise.all((await this.repository.list(this.tenantId)).map((row) => this.get(row.skill_name)));
    return records.filter((record): record is SkillPackageRecord => record !== null);
  }

  async listMetadata(): Promise<SkillPackageMetadata[]> {
    return (await this.repository.list(this.tenantId)).map((row) => {
      const requires = parseRequires(row.metadata);
      return {
        name: row.skill_name, description: row.description, content: row.content,
        metadata: row.metadata, ...(requires ? { requires } : {}),
      };
    });
  }

  async readBundle(name: string): Promise<{ bundle: CreateSkillPackageBundleInput; revision: string } | null> {
    return this.repository.withSnapshot(this.tenantId, name, (snapshot) => this.loadSnapshot(snapshot));
  }

  private async loadSnapshot(snapshot: { row: SkillPackageMetadataRow; files: SkillPackageFileRow[] }) {
    const name = snapshot.row.skill_name;
    const files = [];
    for (const file of snapshot.files) {
      requireSkillPath(file.relative_path);
      const object = await this.objects.get(file.object_key);
      if (!object) throw new Error(`Skill '${name}' 缺少对象: ${file.relative_path}`);
      files.push({ relativePath: file.relative_path, body: object.body, mediaType: file.content_type ?? object.metadata.contentType ?? guessMime(file.relative_path) });
    }
    // Permanent read normalization for historical packages whose file table omitted SKILL.md.
    if (!files.some((file) => file.relativePath === "SKILL.md")) {
      files.push({ relativePath: "SKILL.md", body: Buffer.from(serializeSkillMd(name, snapshot.row.description, snapshot.row.content, snapshot.row.metadata)), mediaType: "text/markdown" });
    }
    return { bundle: { name, description: snapshot.row.description, content: snapshot.row.content, metadata: snapshot.row.metadata, files }, revision: snapshot.row.content_hash };
  }

  async get(name: string): Promise<SkillPackageRecord | null> {
    return this.repository.withSnapshot(this.tenantId, name, async (snapshot) => {
      const cached = this.cacheDirectory(snapshot.row.content_hash);
      const directory = fs.existsSync(path.join(cached, ".materialized"))
        ? cached : this.materializeBundle((await this.loadSnapshot(snapshot)).bundle, snapshot.row.content_hash);
      return toRecord(snapshot.row, directory);
    });
  }

  async createBundle(input: CreateSkillPackageBundleInput): Promise<SkillPackageRecord> { return this.saveBundle(input, null); }

  async saveBundle(input: CreateSkillPackageBundleInput, expectedRevision: string | null): Promise<SkillPackageRecord> {
    const bundle = validateSkillBundle(input.name, input.files);
    const revision = skillBundleRevision(bundle.name, bundle.files);
    const prefix = `tenants/${encodeURIComponent(this.tenantId)}/skills/${encodeURIComponent(bundle.name)}/bundles/${randomUUID()}`;
    const files = [];
    let commitAttempted = false;
    try {
      for (const file of bundle.files) {
        const objectKey = `${prefix}/${file.relativePath.split("/").map(encodeURIComponent).join("/")}`;
        const contentType = file.mediaType ?? guessMime(file.relativePath);
        files.push({ relativePath: file.relativePath, objectKey, contentType, sizeBytes: file.body.byteLength });
        await this.objects.put(objectKey, file.body, contentType);
      }
      // The transaction waits for readers and enqueues retired objects atomically.
      commitAttempted = true;
      await this.repository.saveBundle({ tenantId: this.tenantId, bundle, expectedRevision, contentHash: revision, packagePrefix: prefix, files });
    } catch (error) {
      let committed = false;
      if (commitAttempted) {
        // A lost commit acknowledgement must not cause deletion of a now-live bundle.
        try { committed = (await this.repository.snapshot(this.tenantId, bundle.name))?.row.package_prefix === prefix; }
        catch (verificationError) { throw new AggregateError([error, verificationError], "Skill save result could not be verified; staged objects retained"); }
      }
      if (!committed) {
        // A different current prefix can also mean this commit succeeded and was superseded.
        // Only a known CAS rejection or an upload failure proves these objects were never live.
        if (!commitAttempted || (error instanceof Error && "statusCode" in error && error.statusCode === 409)) {
          try {
            await this.repository.enqueueGarbage(this.tenantId, files.map((file) => file.objectKey));
            await this.reclaimGarbage();
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "Skill save failed and staged cleanup could not be queued");
          }
        }
        throw error;
      }
    }
    await this.reclaimGarbage();
    return toRecord({ skill_name: bundle.name, description: bundle.description, content: bundle.content, metadata: bundle.metadata ?? {} }, this.materializeBundle(bundle, revision));
  }

  async readFile(name: string, relativePath: string): Promise<{ body: Uint8Array; contentType: string } | null> {
    requireSkillPath(relativePath);
    const bundle = await this.readBundle(name);
    const file = bundle?.bundle.files.find((entry) => entry.relativePath === relativePath);
    return file ? { body: file.body, contentType: file.mediaType ?? guessMime(relativePath) } : null;
  }

  async listFiles(name: string): Promise<SkillPackageFileNode[]> {
    const snapshot = await this.readBundle(name);
    const nodes: SkillPackageFileNode[] = [];
    const dirs = new Set<string>();
    for (const file of snapshot?.bundle.files ?? []) {
      const parts = file.relativePath.split("/");
      for (let i = 1; i < parts.length; i++) {
        const directory = parts.slice(0, i).join("/");
        if (!dirs.has(directory)) { dirs.add(directory); nodes.push({ name: parts[i - 1]!, path: directory, type: "directory" }); }
      }
      nodes.push({ name: parts.at(-1)!, path: file.relativePath, type: "file", size: file.body.byteLength });
    }
    return nodes;
  }

  async delete(name: string, expectedRevision?: string): Promise<boolean> {
    const deleted = await this.repository.deletePackage(this.tenantId, name, expectedRevision);
    await this.reclaimGarbage();
    return deleted;
  }

  async materialize(name: string): Promise<string | null> { return (await this.get(name))?.skillDir ?? null; }

  private cacheDirectory(revision: string): string {
    if (!/^[a-f0-9]{24,64}$/.test(revision)) throw new Error("Invalid Skill package revision");
    return path.join(this.cacheRoot, "by-hash", revision);
  }

  /** Cleanup failure must not turn an already committed save/delete into a failure. */
  async reclaimGarbage(): Promise<void> {
    if (!this.reclamation) {
      this.reclamation = this.repository.reclaimGarbage(this.tenantId, (key) => this.objects.delete(key))
        .catch(() => undefined).finally(() => { this.reclamation = null; });
    }
    await this.reclamation;
  }

  private materializeBundle(bundle: CreateSkillPackageBundleInput, revision: string): string {
    const target = this.cacheDirectory(revision);
    if (fs.existsSync(path.join(target, ".materialized"))) return target;
    const staging = path.join(this.cacheRoot, `.staging-${randomUUID()}`);
    fs.mkdirSync(staging, { recursive: true });
    try {
      for (const file of bundle.files) {
        const filePath = path.join(staging, requireSkillPath(file.relativePath));
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, file.body);
      }
      fs.writeFileSync(path.join(staging, ".materialized"), revision);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try { fs.renameSync(staging, target); }
      catch (error) { if (!fs.existsSync(path.join(target, ".materialized"))) throw error; }
      return target;
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
}

function toRecord(
  row: {
    skill_name: string;
    description: string;
    content: string;
    metadata: Record<string, unknown>;
  },
  skillDir: string,
): SkillPackageRecord {
  const requires = parseRequires(row.metadata);
  return {
    name: row.skill_name,
    description: row.description,
    content: row.content,
    skillDir,
    metadata: row.metadata,
    ...(requires ? { requires } : {}),
  };
}

function parseRequires(metadata: Record<string, unknown>): { mcp_servers?: string[]; tools?: string[] } | undefined {
  const mcp = splitCsv(metadata.ragsystem_requires_mcp_servers);
  const tools = splitCsv(metadata.ragsystem_requires_tools);
  if (!mcp && !tools) return undefined;
  return {
    ...(mcp ? { mcp_servers: mcp } : {}),
    ...(tools ? { tools } : {}),
  };
}

function splitCsv(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function guessMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".md") return "text/markdown; charset=utf-8";
  if (ext === ".json") return "application/json";
  if (ext === ".py") return "text/x-python; charset=utf-8";
  if (ext === ".txt" || ext === ".yaml" || ext === ".yml") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

// re-export helpers for tests that may import parse from filesystem store
export { parseSkillMarkdown };
