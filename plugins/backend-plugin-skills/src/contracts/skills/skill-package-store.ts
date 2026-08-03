/** Tenant-owned (user_global) skill package persistence port. */

export interface SkillPackageFileNode {
  name: string;
  /** Relative posix path under the skill package root. */
  path: string;
  type: "file" | "directory";
  size?: number;
}

export interface SkillPackageRecord {
  name: string;
  description: string;
  /** SKILL.md body without frontmatter. */
  content: string;
  /** Local directory ready for script execution (materialized if remote). */
  skillDir: string;
  metadata: Record<string, unknown>;
  requires?: {
    mcp_servers?: string[];
    tools?: string[];
  };
}

export interface SkillPackageBundleFile {
  relativePath: string;
  body: Uint8Array;
  mediaType?: string | null;
}

export interface CreateSkillPackageBundleInput {
  name: string;
  description: string;
  content: string;
  files: readonly SkillPackageBundleFile[];
  metadata?: Record<string, unknown>;
}

/**
 * Persistence + materialization for tenant user_global skills.
 * Builtin and workspace skills stay process/workspace-local and are outside this port.
 */
export interface ISkillPackageStore {
  list(): Promise<SkillPackageRecord[]>;
  get(name: string): Promise<SkillPackageRecord | null>;
  createBundle(input: CreateSkillPackageBundleInput): Promise<SkillPackageRecord>;
  readFile(name: string, relativePath: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  listFiles(name: string): Promise<SkillPackageFileNode[]>;
  delete(name: string): Promise<boolean>;
  /**
   * Ensure package bytes are available on the local filesystem for script execution.
   * Local store returns the durable directory; SaaS store materializes into a content-addressed cache.
   */
  materialize(name: string): Promise<string | null>;
}
