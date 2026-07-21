import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SaaSSkillPackageStore } from "../../src/adapters/saas/object-storage/skill-package-storage.js";
import type { ObjectStorage } from "../../src/contracts/storage/object-storage.js";
import type {
  SkillPackageFileRow,
  SkillPackageMetadataRow,
} from "../../src/adapters/saas/postgres/skill-package-repository.js";
import { SkillToolService } from "../../src/tools/SkillTools/SkillExecution.js";
import type { TenantId } from "../../src/identity/types.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("SaaSSkillPackageStore materialization", () => {
  it("hydrates cold cache so SkillToolService can activate without a prior admin list", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "saas-skill-"));
    tempRoots.push(root);
    const cacheRoot = path.join(root, "skill-cache");
    const objects = new MemoryObjectStorage();
    const repository = new MemorySkillPackageRepository();
    const store = new SaaSSkillPackageStore("tenant-a" as TenantId, repository as never, objects, cacheRoot);

    await store.create({
      name: "cold-skill",
      description: "from object storage",
      content: "# Cold body\n",
    });
    // Simulate a fresh node: wipe local cache while durable SoT remains.
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    expect(fs.existsSync(path.join(cacheRoot, "cold-skill"))).toBe(false);

    const skillTools = new SkillToolService({
      dataRoot: root,
      userGlobalSkillsRoot: cacheRoot,
      packageStore: store,
    });
    const result = await skillTools.activateSkill(
      { skillName: "cold-skill" },
      { sessionId: "s1" } as never,
      {
        agent_name: "agent",
        default_entry: true,
        skills: { enabled_skills: ["cold-skill"] },
      } as never,
    );
    expect(result.isError).not.toBe(true);
    expect(String((result.content as { main_content?: string })?.main_content ?? result.content)).toContain("Cold body");
    expect(fs.existsSync(path.join(cacheRoot, "cold-skill", "SKILL.md"))).toBe(true);
  });

  it("does not write .materialized when an object is missing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "saas-skill-miss-"));
    tempRoots.push(root);
    const cacheRoot = path.join(root, "skill-cache");
    const objects = new MemoryObjectStorage();
    const repository = new MemorySkillPackageRepository();
    const store = new SaaSSkillPackageStore("tenant-a" as TenantId, repository as never, objects, cacheRoot);

    await store.create({
      name: "broken",
      description: "missing object",
      content: "# Body\n",
    });
    // Drop the SKILL.md object after metadata was written.
    for (const key of objects.keys()) {
      await objects.delete(key);
    }
    fs.rmSync(cacheRoot, { recursive: true, force: true });

    await expect(store.materialize("broken")).rejects.toThrow(/物化失败|缺少对象|metadata missing/);
    expect(fs.existsSync(path.join(cacheRoot, "broken", ".materialized"))).toBe(false);
  });

  it("rejects concurrent create of the same skill name with 已存在", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "saas-skill-dup-"));
    tempRoots.push(root);
    const cacheRoot = path.join(root, "skill-cache");
    const objects = new MemoryObjectStorage();
    const repository = new MemorySkillPackageRepository();
    const store = new SaaSSkillPackageStore("tenant-a" as TenantId, repository as never, objects, cacheRoot);

    await store.create({ name: "once", description: "first", content: "a" });
    await expect(store.create({ name: "once", description: "second", content: "b" })).rejects.toThrow("已存在");
  });
});

class MemoryObjectStorage implements ObjectStorage {
  private readonly data = new Map<string, Uint8Array>();

  keys(): string[] {
    return [...this.data.keys()];
  }

  async put(key: string, body: Uint8Array) {
    this.data.set(key, body);
    return { key, contentType: null, contentLength: body.byteLength, etag: null };
  }

  async get(key: string) {
    const body = this.data.get(key);
    if (!body) return null;
    return { body, metadata: { key, contentType: null, contentLength: body.byteLength, etag: null } };
  }

  async head(key: string) {
    const body = this.data.get(key);
    if (!body) return null;
    return { key, contentType: null, contentLength: body.byteLength, etag: null };
  }

  async delete(key: string) {
    return this.data.delete(key);
  }
}

class MemorySkillPackageRepository {
  private readonly packages = new Map<string, SkillPackageMetadataRow>();
  private readonly files = new Map<string, SkillPackageFileRow[]>();

  async list(tenantId: TenantId) {
    return [...this.packages.values()].filter((row) => row.tenant_id === tenantId);
  }

  async get(tenantId: TenantId, skillName: string) {
    const row = this.packages.get(`${tenantId}:${skillName}`);
    return row ?? null;
  }

  async insertPackage(input: {
    tenantId: TenantId;
    skillName: string;
    description: string;
    content: string;
    metadata: Record<string, unknown>;
    contentHash: string;
    packagePrefix: string;
  }) {
    const key = `${input.tenantId}:${input.skillName}`;
    if (this.packages.has(key)) {
      throw Object.assign(new Error(`Skill '${input.skillName}' 已存在`), { code: "23505" });
    }
    const now = new Date().toISOString();
    const row: SkillPackageMetadataRow = {
      tenant_id: input.tenantId,
      skill_name: input.skillName,
      description: input.description,
      content: input.content,
      metadata: input.metadata,
      content_hash: input.contentHash,
      package_prefix: input.packagePrefix,
      created_at: now,
      updated_at: now,
    };
    this.packages.set(key, row);
    this.files.set(key, []);
    return row;
  }

  async upsertPackage(input: {
    tenantId: TenantId;
    skillName: string;
    description: string;
    content: string;
    metadata: Record<string, unknown>;
    contentHash: string;
    packagePrefix: string;
  }) {
    const existing = await this.get(input.tenantId, input.skillName);
    if (!existing) return this.insertPackage(input);
    const row: SkillPackageMetadataRow = {
      ...existing,
      description: input.description,
      content: input.content,
      metadata: input.metadata,
      content_hash: input.contentHash,
      package_prefix: input.packagePrefix,
      updated_at: new Date().toISOString(),
    };
    this.packages.set(`${input.tenantId}:${input.skillName}`, row);
    return row;
  }

  async deletePackage(tenantId: TenantId, skillName: string) {
    const key = `${tenantId}:${skillName}`;
    this.files.delete(key);
    return this.packages.delete(key);
  }

  async listFiles(tenantId: TenantId, skillName: string) {
    return this.files.get(`${tenantId}:${skillName}`) ?? [];
  }

  async upsertFile(input: {
    tenantId: TenantId;
    skillName: string;
    relativePath: string;
    objectKey: string;
    contentType: string | null;
    sizeBytes: number;
  }) {
    const key = `${input.tenantId}:${input.skillName}`;
    const rows = this.files.get(key) ?? [];
    const next: SkillPackageFileRow = {
      tenant_id: input.tenantId,
      skill_name: input.skillName,
      relative_path: input.relativePath,
      object_key: input.objectKey,
      content_type: input.contentType,
      size_bytes: input.sizeBytes,
      updated_at: new Date().toISOString(),
    };
    const idx = rows.findIndex((row) => row.relative_path === input.relativePath);
    if (idx >= 0) rows[idx] = next;
    else rows.push(next);
    this.files.set(key, rows);
    return next;
  }

  async deleteFiles(tenantId: TenantId, skillName: string) {
    this.files.set(`${tenantId}:${skillName}`, []);
  }
}
