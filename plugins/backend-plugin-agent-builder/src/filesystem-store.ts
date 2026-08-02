import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  AgentDraftSchema,
  AgentReleaseSchema,
  type AgentDraft,
  type AgentRelease,
} from "./contracts.js";
import type { AgentBuilderStore } from "./store.js";

export class FilesystemAgentBuilderStore implements AgentBuilderStore {
  private readonly draftsRoot: string;
  private readonly releasesRoot: string;

  constructor(dataRoot: string) {
    const root = path.join(path.resolve(dataRoot), "agent-builder");
    this.draftsRoot = path.join(root, "drafts");
    this.releasesRoot = path.join(root, "releases");
  }

  async listDrafts(): Promise<AgentDraft[]> {
    const drafts = await readRecords(this.draftsRoot, AgentDraftSchema.parse);
    return drafts.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  async getDraft(id: string): Promise<AgentDraft | null> {
    return readRecord(this.draftPath(id), AgentDraftSchema.parse);
  }

  async putDraft(draft: AgentDraft): Promise<void> {
    await writeJson(this.draftPath(draft.id), AgentDraftSchema.parse(draft));
  }

  async listReleases(packageName?: string): Promise<AgentRelease[]> {
    const directories = packageName
      ? [safeSegment(packageName)]
      : await listDirectoryNames(this.releasesRoot);
    const releases: AgentRelease[] = [];
    for (const directory of directories) {
      releases.push(...await readRecords(path.join(this.releasesRoot, directory), AgentReleaseSchema.parse));
    }
    return releases.sort((left, right) => {
      const byName = left.package_name.localeCompare(right.package_name);
      return byName === 0 ? right.version - left.version : byName;
    });
  }

  async getRelease(id: string): Promise<AgentRelease | null> {
    const releases = await this.listReleases();
    return releases.find((release) => release.id === id) ?? null;
  }

  async createRelease(release: AgentRelease): Promise<void> {
    const parsed = AgentReleaseSchema.parse(release);
    const file = this.releasePath(parsed.package_name, parsed.version);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, serialize(parsed), { encoding: "utf8", flag: "wx" });
  }

  async deleteRelease(id: string): Promise<void> {
    const release = await this.getRelease(id);
    if (!release) return;
    await rm(this.releasePath(release.package_name, release.version), { force: true });
  }

  private draftPath(id: string): string {
    return path.join(this.draftsRoot, `${safeSegment(id)}.json`);
  }

  private releasePath(packageName: string, version: number): string {
    return path.join(this.releasesRoot, safeSegment(packageName), `v${version}.json`);
  }
}

async function readRecords<Value>(directory: string, parse: (value: unknown) => Value): Promise<Value[]> {
  const names = await listFileNames(directory);
  const records: Value[] = [];
  for (const name of names) {
    const record = await readRecord(path.join(directory, name), parse);
    if (record) records.push(record);
  }
  return records;
}

async function readRecord<Value>(file: string, parse: (value: unknown) => Value): Promise<Value | null> {
  try {
    return parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, serialize(value), "utf8");
  await rm(file, { force: true });
  await rename(temporary, file);
}

async function listFileNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function listDirectoryNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function safeSegment(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) throw new Error(`Invalid storage identifier '${value}'`);
  return normalized;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
