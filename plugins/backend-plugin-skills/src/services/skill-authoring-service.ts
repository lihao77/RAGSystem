import { mkdir, readdir, readFile, lstat, realpath, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { HttpError } from "@ragsystem/backend-core/utils/errors.js";
import { decodeSkillFiles, skillBundleRevision, requireSkillPath, SaveSkillBundleSchema, SkillNameSchema, validateSkillBundle, type SaveSkillBundle } from "../contracts/skills/skill-bundle.js";
import { serializeSkillMd } from "../contracts/skills/skill-markdown.js";
import type { SkillPackageBundleFile } from "../contracts/skills/skill-package-store.js";
import type { SkillLibraryService } from "./skill-library-service.js";

const WorkspaceManifest = z.object({ name: SkillNameSchema, expected_revision: z.string().regex(/^[a-f0-9]{24,64}$/).nullable() }).strict();

/** Temporary editing lives in the browser/session workspace; only complete Skills are persisted. */
export class SkillAuthoringService {
  constructor(private readonly library: SkillLibraryService) {}

  async listSkills(query = "") {
    const normalized = query.trim().toLowerCase();
    return (await this.library.listSkills()).filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(normalized));
  }

  async getBundle(name: string) {
    const snapshot = await this.library.readSkillBundle(name);
    return {
      name, description: snapshot.bundle.description, content: snapshot.bundle.content,
      revision: snapshot.revision, writable: snapshot.writable,
      files: snapshot.bundle.files.map((file) => ({ relative_path: file.relativePath, media_type: file.mediaType ?? "application/octet-stream", body_base64: Buffer.from(file.body).toString("base64") })),
    };
  }

  async saveBundle(name: string, input: SaveSkillBundle) {
    const parsed = SaveSkillBundleSchema.parse(input);
    const bundle = validateSkillBundle(name, decodeSkillFiles(parsed.files));
    await this.library.saveSkillBundle(bundle, parsed.expected_revision);
    return { name, description: bundle.description, content: bundle.content, revision: skillBundleRevision(name, bundle.files), writable: true, files: parsed.files };
  }

  async openWorkspace(name: string, workspaceRoot: string, description?: string) {
    SkillNameSchema.parse(name);
    const existing = (await this.library.listSkills()).find((skill) => skill.name === name);
    if (existing && existing.source_type !== "user_global") throw new HttpError(403, "forbidden", "内置和工作区 Skill 只读");
    const snapshot = existing ? await this.library.readSkillBundle(name) : null;
    if (!snapshot && !description?.trim()) throw new HttpError(404, "not_found", `Skill '${name}' 不存在`);
    const workspacePath = path.join(path.resolve(workspaceRoot), ".ragsystem", "skill-builder", "skills", `${name}-${randomUUID()}`);
    await mkdir(workspacePath, { recursive: true });
    await assertWorkspacePath(workspaceRoot, workspacePath);
    await writeFile(path.join(workspacePath, "manifest.json"), JSON.stringify({ name, expected_revision: snapshot?.revision ?? null }), "utf8");
    const files = snapshot?.bundle.files ?? [{ relativePath: "SKILL.md", body: Buffer.from(serializeSkillMd(name, description!, "")) }];
    for (const file of files) {
      const target = path.join(workspacePath, requireSkillPath(file.relativePath));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.body);
    }
    return { name, workspace_path: path.relative(workspaceRoot, workspacePath).split(path.sep).join("/"), entry_file: "SKILL.md", revision: snapshot?.revision ?? null };
  }

  async saveWorkspace(relativePath: string, workspaceRoot: string) {
    requireSkillPath(relativePath);
    const workspacePath = path.resolve(workspaceRoot, relativePath);
    await assertWorkspacePath(workspaceRoot, workspacePath);
    const manifestPath = path.join(workspacePath, "manifest.json");
    if ((await lstat(manifestPath)).isSymbolicLink()) throw new HttpError(422, "validation_failed", "Workspace manifest cannot be a symlink");
    const manifest = WorkspaceManifest.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    const files: SkillPackageBundleFile[] = [];
    let bytes = 0;
    const walk = async (directory: string, prefix = ""): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (relative === "manifest.json") continue;
        if (entry.isSymbolicLink()) throw new HttpError(422, "validation_failed", "Skill files cannot be symlinks");
        if ([".venv", "node_modules", "__pycache__", ".cache"].includes(entry.name)) continue;
        requireSkillPath(relative);
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(target, relative);
        else if (entry.isFile()) {
          bytes += (await lstat(target)).size;
          if (bytes > 50 * 1024 * 1024 || files.length >= 256) throw new HttpError(413, "payload_too_large", "Skill exceeds 50MB or 256 files");
          files.push({ relativePath: relative, body: await readFile(target) });
        }
      }
    };
    await walk(workspacePath);
    const bundle = validateSkillBundle(manifest.name, files);
    await this.library.saveSkillBundle(bundle, manifest.expected_revision);
    const saved = { name: manifest.name, revision: skillBundleRevision(manifest.name, files), files };
    await writeFile(manifestPath, JSON.stringify({ name: manifest.name, expected_revision: saved.revision }), "utf8");
    return { name: saved.name, revision: saved.revision, available_for_binding: true, file_count: saved.files.length, workspace_path: relativePath };
  }
}

async function assertWorkspacePath(root: string, candidate: string): Promise<void> {
  const relative = path.relative(await realpath(root), await realpath(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new HttpError(403, "forbidden", "Skill workspace must stay inside the current Session workspace");
}
