import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { HttpError } from "@ragsystem/backend-core/utils/errors.js";
import type { CreateSkillPackageBundleInput, ISkillPackageStore } from "../contracts/skills/skill-package-store.js";
import type { SkillInfo, SkillListItem, SkillToolService } from "../tools/SkillExecution.js";

export interface SkillFileNode {
  name: string;
  /** 相对 skill 目录的 posix 路径。 */
  path: string;
  type: "file" | "directory";
  size?: number;
}

export interface SkillDetail {
  name: string;
  display_name: string;
  description: string;
  source_type: string;
  source_label: string;
  /** SKILL.md 正文（去 frontmatter）。 */
  content: string;
  files: SkillFileNode[];
  /** Published bundles are immutable; changes arrive through a new Artifact candidate. */
  writable: boolean;
}

export type CreateSkillBundleInput = CreateSkillPackageBundleInput;

const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/;

/**
 * Skill 库管理服务。
 * 租户发布包经 ISkillPackageStore（Local 文件 / SaaS PG+对象存储）持久化，正文只能通过新 Artifact 候选变更。
 * builtin/workspace 只读，仍由 SkillToolService 解析。
 */
export class SkillLibraryService {
  constructor(
    private readonly skillTools: SkillToolService,
    private readonly packageStore: ISkillPackageStore,
  ) {}

  async listSkills(): Promise<SkillListItem[]> {
    return this.skillTools.listAvailableSkillsAsync();
  }

  async getSkillDetail(name: string): Promise<SkillDetail> {
    await this.skillTools.hydrateUserGlobalPackages();
    const skill = this.findSkill(name);
    const files = skill.sourceType === "user_global"
      ? await this.packageStore.listFiles(skill.name)
      : listLocalSkillFiles(skill.skillDir);
    return {
      name: skill.name,
      display_name: titleCase(skill.name.replaceAll("-", " ")),
      description: skill.description,
      source_type: skill.sourceType,
      source_label: skill.sourceLabel,
      content: skill.content,
      files,
      writable: false,
    };
  }

  async readSkillFile(name: string, relativePath: string): Promise<{ buffer: Buffer; mime: string }> {
    await this.skillTools.hydrateUserGlobalPackages();
    const skill = this.findSkill(name);
    if (skill.sourceType === "user_global") {
      try {
        const file = await this.packageStore.readFile(skill.name, relativePath);
        if (!file) throw new HttpError(404, "not_found", "文件不存在");
        return { buffer: Buffer.from(file.body), mime: file.contentType };
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, "invalid_request", error instanceof Error ? error.message : String(error));
      }
    }
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) throw new HttpError(400, "invalid_request", "非法的文件路径");
    const filePath = path.resolve(skill.skillDir, normalized);
    if (!isPathUnder(filePath, skill.skillDir) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new HttpError(404, "not_found", "文件不存在");
    }
    return { buffer: fs.readFileSync(filePath), mime: guessMime(filePath) };
  }

  async createSkillBundle(input: CreateSkillBundleInput): Promise<SkillDetail> {
    const name = input.name.trim();
    if (!SKILL_NAME_PATTERN.test(name)) throw new HttpError(400, "invalid_request", "Skill 名称只能包含小写字母、数字和连字符");
    if (!input.description.trim()) throw new HttpError(400, "invalid_request", "description 不能为空");
    try {
      await this.packageStore.createBundle({ ...input, name });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("已存在")) throw new HttpError(409, "conflict", message);
      throw new HttpError(400, "invalid_request", message);
    }
    await this.skillTools.hydrateUserGlobalPackages();
    return this.getSkillDetail(name);
  }

  async matchesSkillBundle(name: string, files: readonly { relativePath: string; body: Uint8Array }[]): Promise<boolean> {
    await this.skillTools.hydrateUserGlobalPackages();
    const skill = this.findSkill(name);
    if (skill.sourceType !== "user_global") return false;
    const expected = new Map(files.map((file) => [file.relativePath, file.body]));
    const actual = (await this.packageStore.listFiles(name)).filter((file) => file.type === "file");
    if (actual.length !== expected.size || actual.some((file) => !expected.has(file.path))) return false;
    for (const file of actual) {
      const stored = await this.packageStore.readFile(name, file.path);
      const body = expected.get(file.path);
      if (!stored || !body || stored.body.byteLength !== body.byteLength
        || createHash("sha256").update(stored.body).digest("hex") !== createHash("sha256").update(body).digest("hex")) return false;
    }
    return true;
  }

  async deleteSkill(name: string): Promise<{ name: string; purged_agents: string[] }> {
    await this.skillTools.hydrateUserGlobalPackages();
    const skill = this.findSkill(name);
    this.assertWritable(skill);
    const deleted = await this.packageStore.delete(skill.name);
    if (!deleted) {
      throw new HttpError(404, "not_found", `Skill '${name}' 不存在`);
    }
    // Drop deleted package from discovery cache immediately.
    await this.skillTools.hydrateUserGlobalPackages();
    const purged_agents = await this.skillTools.purgeSkillReference(name);
    return { name, purged_agents };
  }

  private findSkill(name: string): SkillInfo {
    const normalized = name.trim();
    const skill = this.skillTools.loadAllSkills().find((item) => item.name === normalized);
    if (!skill) {
      throw new HttpError(404, "not_found", `Skill '${normalized}' 不存在`);
    }
    return skill;
  }

  private assertWritable(skill: SkillInfo): void {
    if (skill.sourceType !== "user_global") {
      throw new HttpError(403, "forbidden", `Skill '${skill.name}' 来源为 ${skill.sourceLabel}，仅用户全局 Skill 可删除`);
    }
  }

}

function listLocalSkillFiles(skillDir: string): SkillFileNode[] {
  const skip = new Set([".venv", ".cache", "__pycache__", ".installed", "node_modules", ".DS_Store", ".materialized"]);
  const result: SkillFileNode[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        result.push({ name: entry.name, path: rel, type: "directory" });
        walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        result.push({ name: entry.name, path: rel, type: "file", size: fs.statSync(path.join(dir, entry.name)).size });
      }
    }
  };
  walk(skillDir, "");
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeRelativePath(raw: string): string | null {
  if (typeof raw !== "string" || raw.includes("\0")) return null;
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) return null;
  if (trimmed.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) return null;
  return trimmed;
}

function isPathUnder(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function guessMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".md": "text/markdown; charset=utf-8",
    ".py": "text/x-python; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".yaml": "text/yaml; charset=utf-8",
    ".yml": "text/yaml; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
  };
  return map[ext] ?? "application/octet-stream";
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (item) => item.toUpperCase());
}
