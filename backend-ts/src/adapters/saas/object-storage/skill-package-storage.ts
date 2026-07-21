import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  CreateSkillPackageInput,
  ISkillPackageStore,
  SkillPackageFileNode,
  SkillPackageRecord,
  UpdateSkillPackageInput,
} from "../../../contracts/skills/skill-package-store.js";
import type { ObjectStorage } from "../../../contracts/storage/object-storage.js";
import type { TenantId } from "../../../identity/types.js";
import {
  parseSkillMarkdown,
  serializeSkillMd,
} from "../../filesystem/skills/filesystem-skill-package-store.js";
import type { PostgresSkillPackageRepository } from "../postgres/skill-package-repository.js";

/**
 * SaaS skill packages: Postgres metadata + object storage bytes.
 * Execution materializes packages into a content-addressed local cache under cacheRoot.
 * Durable source of truth is never tenants/<id>/skills on disk.
 */
export class SaaSSkillPackageStore implements ISkillPackageStore {
  /** Per-hash materialize single-flight within this process. */
  private readonly materializeInflight = new Map<string, Promise<string>>();

  constructor(
    private readonly tenantId: TenantId,
    private readonly repository: PostgresSkillPackageRepository,
    private readonly objects: ObjectStorage,
    private readonly cacheRoot: string,
  ) {
    if (!tenantId.trim()) throw new Error("SaaS skill package store requires a tenant id");
    if (!cacheRoot.trim()) throw new Error("SaaS skill package store requires a cache root");
  }

  async list(): Promise<SkillPackageRecord[]> {
    const rows = await this.repository.list(this.tenantId);
    const records: SkillPackageRecord[] = [];
    for (const row of rows) {
      const skillDir = await this.materializeRow(row.skill_name, row.content_hash, row.package_prefix);
      records.push(toRecord(row, skillDir));
    }
    return records;
  }

  async get(name: string): Promise<SkillPackageRecord | null> {
    const row = await this.repository.get(this.tenantId, name);
    if (!row) return null;
    const skillDir = await this.materializeRow(row.skill_name, row.content_hash, row.package_prefix);
    return toRecord(row, skillDir);
  }

  async create(input: CreateSkillPackageInput): Promise<SkillPackageRecord> {
    const markdown = serializeSkillMd(input.name, input.description, input.content);
    const packagePrefix = this.packagePrefix(input.name);
    const skillKey = this.objectKey(packagePrefix, "SKILL.md");
    const contentHash = hashText(markdown);
    // Claim the name in Postgres first so concurrent creates race on PK (409), not silent overwrite.
    const row = await this.repository.insertPackage({
      tenantId: this.tenantId,
      skillName: input.name,
      description: input.description,
      content: input.content,
      metadata: {},
      contentHash,
      packagePrefix,
    });
    try {
      await this.objects.put(skillKey, Buffer.from(markdown, "utf8"), "text/markdown; charset=utf-8");
      await this.repository.upsertFile({
        tenantId: this.tenantId,
        skillName: input.name,
        relativePath: "SKILL.md",
        objectKey: skillKey,
        contentType: "text/markdown; charset=utf-8",
        sizeBytes: Buffer.byteLength(markdown, "utf8"),
      });
      const skillDir = await this.materializeRow(row.skill_name, row.content_hash, row.package_prefix);
      return toRecord(row, skillDir);
    } catch (error) {
      await this.repository.deletePackage(this.tenantId, input.name).catch(() => undefined);
      await this.objects.delete(skillKey).catch(() => undefined);
      throw error;
    }
  }

  async updateMarkdown(name: string, input: UpdateSkillPackageInput): Promise<SkillPackageRecord> {
    const existing = await this.repository.get(this.tenantId, name);
    if (!existing) throw new Error(`Skill '${name}' 不存在`);
    const description = input.description?.trim() || existing.description;
    const content = input.content ?? existing.content;
    const markdown = serializeSkillMd(name, description, content);
    const skillKey = this.objectKey(existing.package_prefix, "SKILL.md");
    await this.objects.put(skillKey, Buffer.from(markdown, "utf8"), "text/markdown; charset=utf-8");
    // New content → new hash directory; never mutate/rm the previous by-hash tree in place.
    const contentHash = hashText(`${existing.content_hash}:${markdown}`);
    const row = await this.repository.upsertPackage({
      tenantId: this.tenantId,
      skillName: name,
      description,
      content,
      metadata: existing.metadata,
      contentHash,
      packagePrefix: existing.package_prefix,
    });
    await this.repository.upsertFile({
      tenantId: this.tenantId,
      skillName: name,
      relativePath: "SKILL.md",
      objectKey: skillKey,
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: Buffer.byteLength(markdown, "utf8"),
    });
    const skillDir = await this.materializeRow(row.skill_name, row.content_hash, row.package_prefix);
    return toRecord(row, skillDir);
  }

  async writeFile(name: string, relativePath: string, body: Uint8Array): Promise<SkillPackageRecord> {
    const existing = await this.repository.get(this.tenantId, name);
    if (!existing) throw new Error(`Skill '${name}' 不存在`);
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) throw new Error("非法的文件路径");
    if (normalized === "SKILL.md") throw new Error("SKILL.md 请用更新正文接口修改");
    const isRootFile = !normalized.includes("/");
    const topSegment = normalized.split("/")[0];
    if (!isRootFile && topSegment !== "scripts") {
      throw new Error("文件仅可上传到 scripts/ 目录或 Skill 根目录");
    }
    const objectKey = this.objectKey(existing.package_prefix, normalized);
    await this.objects.put(objectKey, body, guessMime(normalized));
    await this.repository.upsertFile({
      tenantId: this.tenantId,
      skillName: name,
      relativePath: normalized,
      objectKey,
      contentType: guessMime(normalized),
      sizeBytes: body.byteLength,
    });
    // New content → new hash directory; previous by-hash tree stays immutable.
    const contentHash = hashText(`${existing.content_hash}:${normalized}:${body.byteLength}`);
    const row = await this.repository.upsertPackage({
      tenantId: this.tenantId,
      skillName: name,
      description: existing.description,
      content: existing.content,
      metadata: existing.metadata,
      contentHash,
      packagePrefix: existing.package_prefix,
    });
    const skillDir = await this.materializeRow(row.skill_name, row.content_hash, row.package_prefix);
    return toRecord(row, skillDir);
  }

  async readFile(name: string, relativePath: string): Promise<{ body: Uint8Array; contentType: string } | null> {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) return null;
    const files = await this.repository.listFiles(this.tenantId, name);
    const file = files.find((item) => item.relative_path === normalized);
    if (!file) return null;
    const object = await this.objects.get(file.object_key);
    if (!object) return null;
    return {
      body: object.body,
      contentType: file.content_type ?? object.metadata.contentType ?? "application/octet-stream",
    };
  }

  async listFiles(name: string): Promise<SkillPackageFileNode[]> {
    const files = await this.repository.listFiles(this.tenantId, name);
    const nodes: SkillPackageFileNode[] = [];
    const dirs = new Set<string>();
    for (const file of files) {
      const parts = file.relative_path.split("/");
      for (let i = 0; i < parts.length - 1; i += 1) {
        const dirPath = parts.slice(0, i + 1).join("/");
        if (!dirs.has(dirPath)) {
          dirs.add(dirPath);
          nodes.push({ name: parts[i]!, path: dirPath, type: "directory" });
        }
      }
      nodes.push({
        name: parts[parts.length - 1]!,
        path: file.relative_path,
        type: "file",
        size: file.size_bytes,
      });
    }
    return nodes;
  }

  async delete(name: string): Promise<boolean> {
    const existing = await this.repository.get(this.tenantId, name);
    if (!existing) return false;
    const files = await this.repository.listFiles(this.tenantId, name);
    await this.repository.deletePackage(this.tenantId, name);
    for (const file of files) {
      await this.objects.delete(file.object_key).catch(() => undefined);
    }
    // Drop this skill's current content-addressed cache; unreferenced older hashes can GC later.
    fs.rmSync(this.hashCacheDir(existing.content_hash), { recursive: true, force: true });
    return true;
  }

  async materialize(name: string): Promise<string | null> {
    const row = await this.repository.get(this.tenantId, name);
    if (!row) return null;
    return this.materializeRow(row.skill_name, row.content_hash, row.package_prefix);
  }

  private packagePrefix(skillName: string): string {
    return `tenants/${encodeURIComponent(this.tenantId)}/skills/${encodeURIComponent(skillName)}`;
  }

  private objectKey(packagePrefix: string, relativePath: string): string {
    return `${packagePrefix}/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
  }

  private hashCacheDir(contentHash: string): string {
    return path.join(this.cacheRoot, "by-hash", contentHash);
  }

  /**
   * Materialize into cacheRoot/by-hash/<contentHash>/ (content-addressed, immutable).
   * Complete tree is staged then renamed; incomplete materialization never publishes.
   * Same-hash concurrent callers share one in-flight promise so a rebuild never rm's a
   * just-published tree from a peer.
   */
  private async materializeRow(skillName: string, contentHash: string, _packagePrefix: string): Promise<string> {
    const existing = this.materializeInflight.get(contentHash);
    if (existing) return existing;
    const pending = this.materializeRowExclusive(skillName, contentHash).finally(() => {
      if (this.materializeInflight.get(contentHash) === pending) {
        this.materializeInflight.delete(contentHash);
      }
    });
    this.materializeInflight.set(contentHash, pending);
    return pending;
  }

  private async materializeRowExclusive(skillName: string, contentHash: string): Promise<string> {
    const skillDir = this.hashCacheDir(contentHash);
    const skillMd = path.join(skillDir, "SKILL.md");
    if (fs.existsSync(skillMd) && fs.statSync(skillMd).isFile()) {
      return skillDir;
    }
    // Incomplete/corrupt published dir only: never delete a complete peer tree.
    if (fs.existsSync(skillDir)) {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    // Unique staging path so concurrent processes/hash rebuilds never rm each other's tree.
    const stagingDir = path.join(
      this.cacheRoot,
      `.staging-${contentHash}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    );
    fs.mkdirSync(stagingDir, { recursive: true });
    try {
      const files = await this.repository.listFiles(this.tenantId, skillName);
      const missing: string[] = [];
      for (const file of files) {
        const object = await this.objects.get(file.object_key);
        if (!object) {
          missing.push(file.relative_path);
          continue;
        }
        const target = path.join(stagingDir, ...file.relative_path.split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, object.body);
      }
      // Ensure SKILL.md exists even if file table lagged (content is denormalized in package row).
      if (!fs.existsSync(path.join(stagingDir, "SKILL.md"))) {
        const row = await this.repository.get(this.tenantId, skillName);
        if (!row) throw new Error(`Skill '${skillName}' metadata missing during materialize`);
        fs.writeFileSync(
          path.join(stagingDir, "SKILL.md"),
          serializeSkillMd(row.skill_name, row.description, row.content),
        );
      }
      if (missing.length > 0) {
        throw new Error(`Skill '${skillName}' 物化失败，缺少对象: ${missing.join(", ")}`);
      }
      // Optional self-check marker; directory name is the content address.
      fs.writeFileSync(path.join(stagingDir, ".materialized"), contentHash, "utf8");
      // Publish only after a complete staging tree is ready (atomic rename into by-hash).
      fs.mkdirSync(path.dirname(skillDir), { recursive: true });
      try {
        fs.renameSync(stagingDir, skillDir);
      } catch (error) {
        // Concurrent materialize of the same hash may have won the race.
        if (fs.existsSync(skillMd) && fs.statSync(skillMd).isFile()) {
          fs.rmSync(stagingDir, { recursive: true, force: true });
          return skillDir;
        }
        throw error;
      }
      return skillDir;
    } catch (error) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw error;
    }
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

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}

function normalizeRelativePath(value: string): string | null {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "").trim();
  if (!normalized || normalized.includes("\0") || normalized.split("/").some((part) => part === ".." || part === "")) {
    return null;
  }
  return normalized;
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
