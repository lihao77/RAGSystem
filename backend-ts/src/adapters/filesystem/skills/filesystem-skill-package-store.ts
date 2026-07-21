import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import type {
  CreateSkillPackageInput,
  ISkillPackageStore,
  SkillPackageFileNode,
  SkillPackageRecord,
  UpdateSkillPackageInput,
} from "../../../contracts/skills/skill-package-store.js";
import { isRecord } from "../../../utils/guards.js";

const SKIP_ENTRIES = new Set([".venv", ".cache", "__pycache__", ".installed", "node_modules", ".DS_Store"]);

/** Local filesystem implementation of tenant user_global skill packages. */
export class FilesystemSkillPackageStore implements ISkillPackageStore {
  constructor(private readonly root: string) {
    if (!root.trim()) throw new Error("FilesystemSkillPackageStore requires a root directory");
  }

  async list(): Promise<SkillPackageRecord[]> {
    const records: SkillPackageRecord[] = [];
    for (const skillDir of listSkillDirs(this.root)) {
      const record = parseSkillDir(skillDir);
      if (record) records.push(record);
    }
    return records.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string): Promise<SkillPackageRecord | null> {
    const skillDir = path.join(this.root, name);
    if (!isPathUnder(skillDir, this.root) || !fs.existsSync(skillDir)) return null;
    return parseSkillDir(skillDir);
  }

  async create(input: CreateSkillPackageInput): Promise<SkillPackageRecord> {
    const skillDir = path.join(this.root, input.name);
    if (!isPathUnder(skillDir, this.root)) throw new Error("非法的 Skill 名称");
    if (fs.existsSync(skillDir)) throw new Error(`Skill '${input.name}' 已存在`);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), serializeSkillMd(input.name, input.description, input.content));
    const record = await this.get(input.name);
    if (!record) throw new Error(`Skill '${input.name}' 创建失败`);
    return record;
  }

  async updateMarkdown(name: string, input: UpdateSkillPackageInput): Promise<SkillPackageRecord> {
    const existing = await this.get(name);
    if (!existing) throw new Error(`Skill '${name}' 不存在`);
    const description = input.description?.trim() || existing.description;
    const content = input.content ?? existing.content;
    fs.writeFileSync(path.join(existing.skillDir, "SKILL.md"), serializeSkillMd(name, description, content));
    const record = await this.get(name);
    if (!record) throw new Error(`Skill '${name}' 更新失败`);
    return record;
  }

  async writeFile(name: string, relativePath: string, body: Uint8Array): Promise<SkillPackageRecord> {
    const existing = await this.get(name);
    if (!existing) throw new Error(`Skill '${name}' 不存在`);
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) throw new Error("非法的文件路径");
    if (normalized === "SKILL.md") throw new Error("SKILL.md 请用更新正文接口修改");
    const isRootFile = !normalized.includes("/");
    const topSegment = normalized.split("/")[0];
    if (!isRootFile && topSegment !== "scripts") {
      throw new Error("文件仅可上传到 scripts/ 目录或 Skill 根目录");
    }
    const filePath = path.resolve(existing.skillDir, normalized);
    if (!isPathUnder(filePath, existing.skillDir)) throw new Error("文件路径越出 Skill 目录");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, body);
    const record = await this.get(name);
    if (!record) throw new Error(`Skill '${name}' 写文件后读取失败`);
    return record;
  }

  async readFile(name: string, relativePath: string): Promise<{ body: Uint8Array; contentType: string } | null> {
    const existing = await this.get(name);
    if (!existing) return null;
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) throw new Error("非法的文件路径");
    const filePath = path.resolve(existing.skillDir, normalized);
    if (!isPathUnder(filePath, existing.skillDir) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return null;
    }
    return { body: fs.readFileSync(filePath), contentType: guessMime(filePath) };
  }

  async listFiles(name: string): Promise<SkillPackageFileNode[]> {
    const existing = await this.get(name);
    if (!existing) return [];
    return listSkillFiles(existing.skillDir);
  }

  async delete(name: string): Promise<boolean> {
    const skillDir = path.join(this.root, name);
    if (!isPathUnder(skillDir, this.root) || !fs.existsSync(skillDir)) return false;
    fs.rmSync(skillDir, { recursive: true, force: true });
    return true;
  }

  async materialize(name: string): Promise<string | null> {
    const existing = await this.get(name);
    return existing?.skillDir ?? null;
  }
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

export function parseSkillMarkdown(raw: string): {
  name: string;
  description: string;
  content: string;
  metadata: Record<string, unknown>;
  requires?: { mcp_servers?: string[]; tools?: string[] };
} | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return {
      name: "",
      description: "",
      content: raw.trim(),
      metadata: {},
    };
  }
  let frontmatter: unknown;
  try {
    frontmatter = YAML.parse(match[1] ?? "");
  } catch {
    return null;
  }
  if (!isRecord(frontmatter)) return null;
  const name = String(frontmatter.name ?? "").trim();
  const description = String(frontmatter.description ?? "").trim();
  const metadata = isRecord(frontmatter.metadata) ? frontmatter.metadata : {};
  const requires = parseRequires(metadata);
  return {
    name,
    description,
    content: (match[2] ?? "").replace(/^\r?\n/, ""),
    metadata,
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

export function serializeSkillMd(name: string, description: string, content: string): string {
  const body = content.replace(/^\r?\n/, "");
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}

function listSkillFiles(skillDir: string, relative = ""): SkillPackageFileNode[] {
  const current = relative ? path.join(skillDir, relative) : skillDir;
  if (!fs.existsSync(current) || !fs.statSync(current).isDirectory()) return [];
  const nodes: SkillPackageFileNode[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (SKIP_ENTRIES.has(entry.name) || entry.name.startsWith(".")) continue;
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

function normalizeRelativePath(value: string): string | null {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "").trim();
  if (!normalized || normalized.includes("\0") || normalized.split("/").some((part) => part === ".." || part === "")) {
    return null;
  }
  return normalized;
}

function isPathUnder(target: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
}

function guessMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".md") return "text/markdown; charset=utf-8";
  if (ext === ".json") return "application/json";
  if (ext === ".py") return "text/x-python; charset=utf-8";
  if (ext === ".txt" || ext === ".yaml" || ext === ".yml") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}
