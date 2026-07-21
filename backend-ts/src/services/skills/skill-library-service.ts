import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { HttpError } from "../../utils/errors.js";
import type { SkillInfo, SkillListItem, SkillToolService } from "../../tools/SkillTools/SkillExecution.js";

const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/;
const SKIP_ENTRIES = new Set([".venv", ".cache", "__pycache__", ".installed", "node_modules", ".DS_Store"]);

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
  /** 仅 user_global 来源为 true。 */
  writable: boolean;
}

export interface CreateSkillInput {
  name: string;
  description: string;
  content: string;
}

export interface UpdateSkillInput {
  description?: string;
  content?: string;
}

/**
 * Skill 库管理服务：在 SkillToolService 的目录解析之上提供写操作与文件树列举。
 * 写/删硬限定 sourceType === 'user_global'；builtin/workspace 只读。
 * 根路径与解析逻辑由 SkillToolService 单一持有，本服务只在其结果上做文件操作。
 */
export class SkillLibraryService {
  constructor(private readonly skillTools: SkillToolService) {}

  listSkills(): SkillListItem[] {
    return this.skillTools.listAvailableSkills();
  }

  getSkillDetail(name: string): SkillDetail {
    const skill = this.findSkill(name);
    return {
      name: skill.name,
      display_name: titleCase(skill.name.replaceAll("-", " ")),
      description: skill.description,
      source_type: skill.sourceType,
      source_label: skill.sourceLabel,
      content: skill.content,
      files: listSkillFiles(skill.skillDir),
      writable: skill.sourceType === "user_global",
    };
  }

  readSkillFile(name: string, relativePath: string): { buffer: Buffer; mime: string } {
    const skill = this.findSkill(name);
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) {
      throw new HttpError(400, "invalid_request", "非法的文件路径");
    }
    const filePath = path.resolve(skill.skillDir, normalized);
    if (!isPathUnder(filePath, skill.skillDir) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new HttpError(404, "not_found", "文件不存在");
    }
    return { buffer: fs.readFileSync(filePath), mime: guessMime(filePath) };
  }

  createSkill(input: CreateSkillInput): SkillDetail {
    const name = input.name.trim();
    if (!SKILL_NAME_PATTERN.test(name)) {
      throw new HttpError(400, "invalid_request", "Skill 名称只能包含小写字母、数字和连字符");
    }
    const description = input.description.trim();
    if (!description) {
      throw new HttpError(400, "invalid_request", "description 不能为空");
    }
    const root = this.skillTools.getUserGlobalSkillsRoot();
    const skillDir = path.join(root, name);
    if (!isPathUnder(skillDir, root)) {
      throw new HttpError(400, "invalid_request", "非法的 Skill 名称");
    }
    if (fs.existsSync(skillDir)) {
      throw new HttpError(409, "conflict", `Skill '${name}' 已存在`);
    }
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), serializeSkillMd(name, description, input.content ?? ""));
    return this.getSkillDetail(name);
  }

  updateSkillMd(name: string, input: UpdateSkillInput): SkillDetail {
    const skill = this.findSkill(name);
    this.assertWritable(skill);
    const description = input.description?.trim() || skill.description;
    const content = input.content ?? skill.content;
    fs.writeFileSync(path.join(skill.skillDir, "SKILL.md"), serializeSkillMd(skill.name, description, content));
    return this.getSkillDetail(name);
  }

  writeSkillFile(name: string, relativePath: string, buffer: Buffer): SkillDetail {
    const skill = this.findSkill(name);
    this.assertWritable(skill);
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) {
      throw new HttpError(400, "invalid_request", "非法的文件路径");
    }
    const filePath = path.resolve(skill.skillDir, normalized);
    if (!isPathUnder(filePath, skill.skillDir)) {
      throw new HttpError(400, "invalid_request", "文件路径越出 Skill 目录");
    }
    const relativeToSkill = path.relative(skill.skillDir, filePath).split(path.sep).join("/");
    if (relativeToSkill === "SKILL.md") {
      throw new HttpError(400, "invalid_request", "SKILL.md 请用更新正文接口修改");
    }
    const isRootFile = !relativeToSkill.includes("/");
    const topSegment = relativeToSkill.split("/")[0];
    if (!isRootFile && topSegment !== "scripts") {
      throw new HttpError(400, "invalid_request", "文件仅可上传到 scripts/ 目录或 Skill 根目录");
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);
    return this.getSkillDetail(name);
  }

  async deleteSkill(name: string): Promise<{ name: string; purged_agents: string[] }> {
    const skill = this.findSkill(name);
    this.assertWritable(skill);
    const root = this.skillTools.getUserGlobalSkillsRoot();
    if (!isPathUnder(skill.skillDir, root)) {
      throw new HttpError(403, "forbidden", "仅可删除用户全局 Skill");
    }
    fs.rmSync(skill.skillDir, { recursive: true, force: true });
    // 联动清理所有 AgentConfig 中的 enabled_skills 引用，消除悬空引用。
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
      throw new HttpError(403, "forbidden", `Skill '${skill.name}' 来源为 ${skill.sourceLabel}，仅用户全局 Skill 可编辑`);
    }
  }
}

function serializeSkillMd(name: string, description: string, content: string): string {
  const frontmatter = YAML.stringify({ name, description }).trimEnd();
  return `---\n${frontmatter}\n---\n${content.trim()}\n`;
}

function listSkillFiles(skillDir: string): SkillFileNode[] {
  const result: SkillFileNode[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_ENTRIES.has(entry.name)) {
        continue;
      }
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

/** 规范化相对路径：反斜杠转正斜杠，禁止绝对路径/上层穿越/空字节/空段。 */
function normalizeRelativePath(raw: string): string | null {
  if (typeof raw !== "string" || raw.includes("\0")) {
    return null;
  }
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.startsWith("/")) {
    return null;
  }
  if (trimmed.split("/").some((segment) => segment === ".." || segment === "")) {
    return null;
  }
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
