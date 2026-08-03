import YAML from "yaml";

import { isRecord } from "@ragsystem/backend-core/utils/guards.js";

export interface ParsedSkillMarkdown {
  name: string;
  description: string;
  content: string;
  metadata: Record<string, unknown>;
  requires?: { mcp_servers?: string[]; tools?: string[] };
}

export function parseSkillMarkdown(raw: string): ParsedSkillMarkdown | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { name: "", description: "", content: raw.trim(), metadata: {} };
  }
  let frontmatter: unknown;
  try {
    frontmatter = YAML.parse(match[1] ?? "");
  } catch {
    return null;
  }
  if (!isRecord(frontmatter)) return null;
  const metadata = isRecord(frontmatter.metadata) ? frontmatter.metadata : {};
  const requires = parseRequires(metadata);
  return {
    name: String(frontmatter.name ?? "").trim(),
    description: String(frontmatter.description ?? "").trim(),
    content: (match[2] ?? "").replace(/^\r?\n/, ""),
    metadata,
    ...(requires ? { requires } : {}),
  };
}

export function serializeSkillMd(name: string, description: string, content: string, metadata: Record<string, unknown> = {}): string {
  const body = content.replace(/^\r?\n/, "");
  const metadataYaml = Object.keys(metadata).length > 0
    ? `metadata:\n${Object.entries(metadata).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}\n`).join("")}`
    : "";
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n${metadataYaml}---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}

/** Update only canonical frontmatter fields while retaining unknown YAML keys and body text. */
export function updateSkillMarkdownFrontmatter(raw: string, name: string, description: string): string {
  const match = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)([\s\S]*)$/);
  if (!match) return serializeSkillMd(name, description, raw);
  try {
    const document = YAML.parseDocument(match[2] ?? "");
    if (!isRecord(document.toJSON())) return serializeSkillMd(name, description, match[4] ?? "");
    document.set("name", name);
    document.set("description", description);
    return `${match[1]}${document.toString().trimEnd()}${match[3]}${match[4] ?? ""}`;
  } catch {
    return serializeSkillMd(name, description, match[4] ?? "");
  }
}

function parseRequires(metadata: Record<string, unknown>): ParsedSkillMarkdown["requires"] {
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
