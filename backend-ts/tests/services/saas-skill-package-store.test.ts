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

    const created = await store.create({
      name: "cold-skill",
      description: "from object storage",
      content: "# Cold body\n",
    });
    expect(created.skillDir).toContain(path.join("by-hash", path.sep));
    expect(fs.existsSync(path.join(created.skillDir, "SKILL.md"))).toBe(true);
    // Simulate a fresh node: wipe local cache while durable SoT remains.
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    expect(fs.existsSync(created.skillDir)).toBe(false);

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
    expect(result.success).toBe(true);
    expect(String((result.content as { main_content?: string })?.main_content ?? result.content)).toContain("Cold body");

    const skills = skillTools.loadAllSkills();
    const cold = skills.find((s) => s.name === "cold-skill");
    expect(cold).toBeTruthy();
    expect(cold!.skillDir).toMatch(/by-hash[/\\][a-f0-9]+$/i);
    expect(fs.existsSync(path.join(cold!.skillDir, "SKILL.md"))).toBe(true);
    // Must not fall back to name-based layout.
    expect(fs.existsSync(path.join(cacheRoot, "cold-skill"))).toBe(false);
  });

  it("does not publish by-hash dir when an object is missing", async () => {
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
    const row = await repository.get("tenant-a" as TenantId, "broken");
    expect(row).toBeTruthy();
    // Drop the SKILL.md object after metadata was written.
    for (const key of objects.keys()) {
      await objects.delete(key);
    }
    // Wipe cache so materialize must re-fetch objects.
    fs.rmSync(cacheRoot, { recursive: true, force: true });

    await expect(store.materialize("broken")).rejects.toThrow(/物化失败|缺少对象|metadata missing/);
    const byHashRoot = path.join(cacheRoot, "by-hash");
    if (fs.existsSync(byHashRoot)) {
      // No complete published hash dir for this content.
      const published = fs.readdirSync(byHashRoot).filter((name) => !name.startsWith("."));
      expect(published).toEqual([]);
    }
    // Staging leftovers must be cleaned up.
    const leftovers = fs.existsSync(cacheRoot)
      ? fs.readdirSync(cacheRoot).filter((name) => name.startsWith(".staging-"))
      : [];
    expect(leftovers).toEqual([]);
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

  it("updates into a new by-hash dir without clearing the old hash in place", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "saas-skill-upd-"));
    tempRoots.push(root);
    const cacheRoot = path.join(root, "skill-cache");
    const objects = new MemoryObjectStorage();
    const repository = new MemorySkillPackageRepository();
    const store = new SaaSSkillPackageStore("tenant-a" as TenantId, repository as never, objects, cacheRoot);

    const created = await store.create({
      name: "mutable",
      description: "v1",
      content: "# Version one\n",
    });
    const oldHashDir = created.skillDir;
    const oldHash = path.basename(oldHashDir);
    expect(oldHashDir).toBe(path.join(cacheRoot, "by-hash", oldHash));
    expect(fs.existsSync(path.join(oldHashDir, "SKILL.md"))).toBe(true);
    const oldSkillMd = fs.readFileSync(path.join(oldHashDir, "SKILL.md"), "utf8");

    const updated = await store.updateMarkdown("mutable", {
      description: "v2",
      content: "# Version two\n",
    });
    const newHashDir = updated.skillDir;
    const newHash = path.basename(newHashDir);
    expect(newHashDir).toBe(path.join(cacheRoot, "by-hash", newHash));
    expect(newHash).not.toBe(oldHash);
    expect(updated.skillDir).not.toBe(oldHashDir);
    expect(fs.existsSync(path.join(newHashDir, "SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(newHashDir, "SKILL.md"), "utf8")).toContain("Version two");

    // Old content-addressed tree must remain intact (not wiped and rewritten in place).
    expect(fs.existsSync(oldHashDir)).toBe(true);
    expect(fs.readFileSync(path.join(oldHashDir, "SKILL.md"), "utf8")).toBe(oldSkillMd);

    // writeFile also lands in a fresh by-hash dir.
    const withScript = await store.writeFile("mutable", "scripts/run.py", Buffer.from("print(1)\n"));
    expect(withScript.skillDir).toMatch(/by-hash[/\\][a-f0-9]+$/i);
    expect(withScript.skillDir).not.toBe(newHashDir);
    expect(fs.existsSync(path.join(withScript.skillDir, "scripts", "run.py"))).toBe(true);
    // Previous hashes still present.
    expect(fs.existsSync(oldHashDir)).toBe(true);
    expect(fs.existsSync(newHashDir)).toBe(true);

    // delete removes only the skill's current hash cache.
    const currentHashDir = withScript.skillDir;
    await store.delete("mutable");
    expect(fs.existsSync(currentHashDir)).toBe(false);
  });

  it("single-flights concurrent materialize of the same hash", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "saas-skill-race-"));
    tempRoots.push(root);
    const cacheRoot = path.join(root, "skill-cache");
    const objects = new MemoryObjectStorage();
    const repository = new MemorySkillPackageRepository();
    const store = new SaaSSkillPackageStore("tenant-a" as TenantId, repository as never, objects, cacheRoot);

    const created = await store.create({
      name: "race",
      description: "race",
      content: "# Race body\n",
    });
    fs.rmSync(cacheRoot, { recursive: true, force: true });

    const [a, b, c] = await Promise.all([
      store.materialize("race"),
      store.materialize("race"),
      store.materialize("race"),
    ]);
    expect(a).toBe(created.skillDir);
    expect(b).toBe(created.skillDir);
    expect(c).toBe(created.skillDir);
    expect(fs.existsSync(path.join(created.skillDir, "SKILL.md"))).toBe(true);
    // Only one published hash dir; no staging leftovers.
    const byHashRoot = path.join(cacheRoot, "by-hash");
    expect(fs.readdirSync(byHashRoot)).toEqual([path.basename(created.skillDir)]);
    const leftovers = fs.readdirSync(cacheRoot).filter((name) => name.startsWith(".staging-"));
    expect(leftovers).toEqual([]);
  });

  it("rehydrates packageStore cache after mutate/delete so discovery never stays stale", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "saas-skill-hydrate-"));
    tempRoots.push(root);
    const cacheRoot = path.join(root, "skill-cache");
    const objects = new MemoryObjectStorage();
    const repository = new MemorySkillPackageRepository();
    const store = new SaaSSkillPackageStore("tenant-a" as TenantId, repository as never, objects, cacheRoot);
    const skillTools = new SkillToolService({
      dataRoot: root,
      userGlobalSkillsRoot: cacheRoot,
      packageStore: store,
    });

    await store.create({ name: "alive", description: "v1", content: "# one\n" });
    await skillTools.hydrateUserGlobalPackages();
    expect(skillTools.loadAllSkills().map((s) => s.name)).toContain("alive");

    await store.updateMarkdown("alive", { content: "# two\n" });
    // Concurrent hydrates must serialize; final snapshot sees latest contentDir.
    await Promise.all([
      skillTools.hydrateUserGlobalPackages(),
      skillTools.hydrateUserGlobalPackages(),
    ]);
    const afterUpdate = skillTools.loadAllSkills().find((s) => s.name === "alive");
    expect(afterUpdate).toBeTruthy();
    expect(fs.readFileSync(path.join(afterUpdate!.skillDir, "SKILL.md"), "utf8")).toContain("two");

    await store.delete("alive");
    await skillTools.hydrateUserGlobalPackages();
    expect(skillTools.loadAllSkills().map((s) => s.name)).not.toContain("alive");
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
