import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SkillNameSchema, requireSkillPath, skillBundleRevision, skillRevisionConflict, validateSkillBundle } from "../../contracts/skills/skill-bundle.js";

import type {
  CreateSkillPackageBundleInput,
  ISkillPackageStore,
  SkillPackageFileNode,
  SkillPackageRecord,
} from "../../contracts/skills/skill-package-store.js";
import { parseSkillMarkdown } from "../../contracts/skills/skill-markdown.js";

const SKIP_ENTRIES = new Set([".venv", ".cache", "__pycache__", ".installed", "node_modules", ".DS_Store"]);

/** Local filesystem implementation of tenant user_global skill packages. */
export class FilesystemSkillPackageStore implements ISkillPackageStore {
  constructor(private readonly root: string) {
    if (!root.trim()) throw new Error("FilesystemSkillPackageStore requires a root directory");
  }

  // SQLite serializes filesystem reads/commits across processes, including Windows.
  // All filesystem work inside the transaction is synchronous; no half-bundle is observable.
  private locked<T>(operation: () => T): T {
    fs.mkdirSync(this.root, { recursive: true });
    const db = new DatabaseSync(path.join(this.root, ".package-lock.sqlite"));
    db.exec("PRAGMA busy_timeout = 10000");
    try {
      db.exec("BEGIN IMMEDIATE");
      // Recover a process crash between moving the previous directory and installing the new one.
      for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith(".replacing-")) continue;
        const name = entry.name.slice(".replacing-".length);
        if (!SkillNameSchema.safeParse(name).success) continue;
        const backup = path.join(this.root, entry.name);
        const target = path.join(this.root, name);
        if (!fs.existsSync(target)) fs.renameSync(backup, target);
        else fs.rmSync(backup, { recursive: true, force: true });
      }
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    } finally { db.close(); }
  }

  private directory(name: string): string {
    SkillNameSchema.parse(name);
    const target = path.join(this.root, name);
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error("Skill directory cannot be a symlink");
    return target;
  }

  private snapshot(name: string): { bundle: CreateSkillPackageBundleInput; revision: string } | null {
    const directory = this.directory(name);
    const record = parseSkillDir(directory);
    if (!record) return null;
    const files = listSkillFiles(directory).filter((file) => file.type === "file").map((file) => ({
      relativePath: file.path, body: fs.readFileSync(path.join(directory, file.path)), mediaType: guessMime(file.path),
    }));
    return {
      bundle: { name, description: record.description, content: record.content, metadata: record.metadata, files },
      revision: skillBundleRevision(name, files),
    };
  }

  private executionRecord(name: string): SkillPackageRecord | null {
    const snapshot = this.snapshot(name);
    if (!snapshot) return null;
    const record = parseSkillDir(this.directory(name))!;
    const target = path.join(this.root, ".runtime", snapshot.revision);
    if (!fs.existsSync(path.join(target, ".materialized"))) {
      const staging = path.join(this.root, `.creating-execution-${randomUUID()}`);
      fs.mkdirSync(staging);
      try {
        for (const file of snapshot.bundle.files) {
          const destination = path.join(staging, requireSkillPath(file.relativePath));
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.writeFileSync(destination, file.body);
        }
        fs.writeFileSync(path.join(staging, ".materialized"), snapshot.revision);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(staging, target);
      } finally { fs.rmSync(staging, { recursive: true, force: true }); }
    }
    return { ...record, skillDir: target };
  }

  async list(): Promise<SkillPackageRecord[]> {
    return this.locked(() => listSkillDirs(this.root).map((directory) => this.executionRecord(path.basename(directory)))
      .filter((record): record is SkillPackageRecord => record !== null).sort((a, b) => a.name.localeCompare(b.name)));
  }

  async get(name: string): Promise<SkillPackageRecord | null> {
    return this.locked(() => this.executionRecord(name));
  }

  async readBundle(name: string) { return this.locked(() => this.snapshot(name)); }

  async createBundle(input: CreateSkillPackageBundleInput): Promise<SkillPackageRecord> {
    return this.saveBundle(input, null);
  }

  async saveBundle(input: CreateSkillPackageBundleInput, expectedRevision: string | null): Promise<SkillPackageRecord> {
    const valid = validateSkillBundle(input.name, input.files);
    return this.locked(() => {
      const target = this.directory(valid.name);
      const current = this.snapshot(valid.name);
      if ((current?.revision ?? null) !== expectedRevision || (!current && fs.existsSync(target))) throw skillRevisionConflict();
      const staging = path.join(this.root, `.creating-${valid.name}-${randomUUID()}`);
      const backup = path.join(this.root, `.replacing-${valid.name}`);
      fs.mkdirSync(staging);
      try {
        for (const file of valid.files) {
          const destination = path.join(staging, requireSkillPath(file.relativePath));
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.writeFileSync(destination, file.body);
        }
        if (current) fs.renameSync(target, backup);
        try { fs.renameSync(staging, target); }
        catch (error) {
          if (current) fs.renameSync(backup, target);
          throw error;
        }
        // Once installed, the save succeeded. Deferred backup cleanup is also safe after a crash.
        if (current) { try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* next read recovers */ } }
        return parseSkillDir(target)!;
      } finally { fs.rmSync(staging, { recursive: true, force: true }); }
    });
  }

  async readFile(name: string, relativePath: string): Promise<{ body: Uint8Array; contentType: string } | null> {
    return this.locked(() => {
      const snapshot = this.snapshot(name);
      const file = snapshot?.bundle.files.find((entry) => entry.relativePath === requireSkillPath(relativePath));
      return file ? { body: file.body, contentType: guessMime(file.relativePath) } : null;
    });
  }

  async listFiles(name: string): Promise<SkillPackageFileNode[]> {
    return this.locked(() => listSkillFiles(this.directory(name)));
  }

  async delete(name: string, expectedRevision?: string): Promise<boolean> {
    return this.locked(() => {
      const current = this.snapshot(name);
      if (expectedRevision !== undefined && current?.revision !== expectedRevision) throw skillRevisionConflict();
      if (!current) return false;
      fs.rmSync(this.directory(name), { recursive: true, force: true });
      return true;
    });
  }

  async materialize(name: string): Promise<string | null> { return (await this.get(name))?.skillDir ?? null; }
}

function listSkillDirs(root: string): string[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && fs.existsSync(path.join(root, entry.name, "SKILL.md")))
    .map((entry) => path.join(root, entry.name));
}

function parseSkillDir(skillDir: string): SkillPackageRecord | null {
  const skillMdPath = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillMdPath)) return null;
  try {
    const raw = fs.readFileSync(skillMdPath, "utf8");
    const parsed = parseSkillMarkdown(raw);
    if (!parsed) return null;
    const name = parsed.name || path.basename(skillDir);
    return {
      name,
      description: parsed.description,
      content: parsed.content,
      skillDir,
      metadata: parsed.metadata,
      ...(parsed.requires ? { requires: parsed.requires } : {}),
    };
  } catch {
    return null;
  }
}

function listSkillFiles(skillDir: string, relative = ""): SkillPackageFileNode[] {
  const current = relative ? path.join(skillDir, relative) : skillDir;
  if (!fs.existsSync(current) || !fs.statSync(current).isDirectory()) return [];
  const nodes: SkillPackageFileNode[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (SKIP_ENTRIES.has(entry.name) || entry.name === ".materialized") continue;
    if (entry.isSymbolicLink()) throw new Error("Skill files cannot be symlinks");
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path: childRelative, type: "directory" });
      nodes.push(...listSkillFiles(skillDir, childRelative));
    } else if (entry.isFile()) {
      const size = fs.statSync(path.join(skillDir, childRelative)).size;
      nodes.push({ name: entry.name, path: childRelative, type: "file", size });
    }
  }
  return nodes;
}

function guessMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".md") return "text/markdown; charset=utf-8";
  if (ext === ".json") return "application/json";
  if (ext === ".py") return "text/x-python; charset=utf-8";
  if (ext === ".txt" || ext === ".yaml" || ext === ".yml") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}
