import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { AgentDraftSchema, type AgentDraft } from "./contracts.js";
import type { AgentBuilderStore } from "./store.js";

export class FilesystemAgentBuilderStore implements AgentBuilderStore {
  private readonly draftsRoot: string;

  constructor(dataRoot: string) {
    const root = path.join(path.resolve(dataRoot), "agent-builder");
    this.draftsRoot = path.join(root, "drafts");
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

  async deleteDraft(id: string): Promise<void> {
    await rm(this.draftPath(id), { force: true });
  }

  private draftPath(id: string): string {
    return path.join(this.draftsRoot, `${safeSegment(id)}.json`);
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
