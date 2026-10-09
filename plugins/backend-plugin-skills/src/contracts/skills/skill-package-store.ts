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

/** Discovery metadata has no execution directory and must not populate execution caches. */
export type SkillPackageMetadata = Omit<SkillPackageRecord, "skillDir">;

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
  /** List descriptions without reading resource bytes or materializing execution snapshots. */
  listMetadata?(): Promise<SkillPackageMetadata[]>;
  get(name: string): Promise<SkillPackageRecord | null>;
  createBundle(input: CreateSkillPackageBundleInput): Promise<SkillPackageRecord>;
  /** Read a consistent editable snapshot. Revision is opaque to callers. */
  readBundle(name: string): Promise<{ bundle: CreateSkillPackageBundleInput; revision: string } | null>;
  /** null means create only. Commit a complete bundle with optimistic concurrency. */
  saveBundle(input: CreateSkillPackageBundleInput, expectedRevision: string | null): Promise<SkillPackageRecord>;
  readFile(name: string, relativePath: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  listFiles(name: string): Promise<SkillPackageFileNode[]>;
  delete(name: string, expectedRevision?: string): Promise<boolean>;
  /**
   * Ensure package bytes are available on the local filesystem for script execution.
   * Local store returns the durable directory; SaaS store materializes into a content-addressed cache.
   */
  materialize(name: string): Promise<string | null>;
}
