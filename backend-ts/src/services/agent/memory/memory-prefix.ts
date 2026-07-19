/**
 * memory 前缀：能力/scope 解析 + 指纹 + 渲染块 + 快照。
 * 迿自 SDK memory 模块（原 backend-ts context-builder/memory.ts → SDK → 归位 backend）。
 * 字段对齐 backend AgentConfig.memory（snake_case）。
 */
import crypto from "node:crypto";
import { getWorkspaceMemoryKey, type MemoryScopeSpec } from "../../../contracts/memory-store/index.js";
import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
import {
  asRecord,
  getString,
  isMemoryScopeName,
  MEMORY_INDEX_HEADING_SUFFIX,
  MEMORY_SCOPE_CAPABILITIES_HEADING,
  pythonStableJsonStringify,
  stringArray,
  stringRecord,
  titleCase,
} from "./helpers.js";

/** 默认 thread key（对齐 SDK context/types DEFAULT_THREAD_KEY="root"）。 */
const DEFAULT_THREAD_KEY = "root";

/** backend AgentConfig.memory 形状（snake）。 */
type MemoryConfig = AgentConfig["memory"];

export interface MemoryScopeCapabilities {
  allowed_scopes: string[];
  write_scopes: string[];
  archive_scopes: string[];
}

export interface MemoryPrefixFingerprint {
  agent_name: string | null;
  auto_inject: boolean;
  allowed_scopes: string[];
  write_scopes: string[];
  archive_scopes: string[];
  scope_specs: Array<{ scope_name: string; scope_spec: MemoryScopeSpec }>;
  private_candidate_revision: string;
  scope_revisions?: Array<{ scope_name: string; scope_spec: MemoryScopeSpec; revision: string }>;
  fingerprint: string;
}

export interface MemoryPrefixSnapshot {
  baseline_key: string;
  session_id: string;
  thread_key: string;
  agent_name: string;
  fingerprint: MemoryPrefixFingerprint;
  scope_capabilities: MemoryScopeCapabilities;
  indices: Record<string, string>;
  rendered_block: string;
  rebased_reason: string;
}

/** memory 是否启用（任一 scope 白名单非空）。 */
export function isMemoryEnabled(memory: MemoryConfig): boolean {
  return memory.allowed_scopes.length > 0 || memory.write_scopes.length > 0 || memory.archive_scopes.length > 0;
}

export function buildMemoryScopeCapabilities(memory: MemoryConfig): MemoryScopeCapabilities {
  return {
    allowed_scopes: [...memory.allowed_scopes],
    write_scopes: [...memory.write_scopes],
    archive_scopes: [...memory.archive_scopes],
  };
}

export function buildMemoryScopeSpecs(input: {
  memory: MemoryConfig;
  sessionId: string;
  agentName: string;
  sessionMetadata: Record<string, unknown>;
  userId?: string | null;
  /** Overrides Local's workspace_root-derived key for deployments with stable workspace IDs. */
  workspaceKey?: string | null;
}): MemoryScopeSpec[] {
  const allowedScopes = new Set(input.memory.allowed_scopes);
  const teamName = getString(input.sessionMetadata.team);
  const workspaceKey = input.workspaceKey === undefined
    ? getWorkspaceMemoryKey(getString(input.sessionMetadata.workspace_root))
    : input.workspaceKey?.trim() || null;
  const scopeSpecs: MemoryScopeSpec[] = [];
  if (allowedScopes.has("team") && teamName) {
    scopeSpecs.push({ scope: "team", team_name: teamName });
  }
  if (allowedScopes.has("session")) {
    scopeSpecs.push({ scope: "session", session_id: input.sessionId });
  }
  if (allowedScopes.has("agent") && input.agentName && teamName) {
    scopeSpecs.push({ scope: "agent", agent_name: input.agentName, team_name: teamName });
  }
  if (allowedScopes.has("workspace") && workspaceKey && input.userId) {
    scopeSpecs.push({ scope: "workspace", workspace_key: workspaceKey, user_id: input.userId });
  }
  if (allowedScopes.has("user") && input.userId) {
    scopeSpecs.push({ scope: "user", user_id: input.userId });
  }
  return scopeSpecs;
}

export function buildMemoryPrefixFingerprint(input: {
  memory: MemoryConfig;
  scopeCapabilities: MemoryScopeCapabilities;
  scopeSpecs: MemoryScopeSpec[];
  agentName: string;
  privateCandidateRevision?: string;
  scopeRevisions?: Array<{ scopeSpec: MemoryScopeSpec; revision: string }>;
}): MemoryPrefixFingerprint {
  const payload = {
    agent_name: input.agentName.trim() || null,
    auto_inject: input.memory.auto_inject !== false,
    allowed_scopes: [...input.scopeCapabilities.allowed_scopes].sort(),
    write_scopes: [...input.scopeCapabilities.write_scopes].sort(),
    archive_scopes: [...input.scopeCapabilities.archive_scopes].sort(),
    scope_specs: input.scopeSpecs.map((scopeSpec) => ({ scope_name: scopeSpec.scope, scope_spec: { ...scopeSpec } })),
    private_candidate_revision: input.privateCandidateRevision ?? "",
    ...(input.scopeRevisions
      ? {
          scope_revisions: input.scopeRevisions.map(({ scopeSpec, revision }) => ({
            scope_name: scopeSpec.scope,
            scope_spec: { ...scopeSpec },
            revision,
          })),
        }
      : {}),
  };
  return { ...payload, fingerprint: crypto.createHash("sha256").update(pythonStableJsonStringify(payload), "utf8").digest("hex").slice(0, 16) };
}

export function renderMemoryPrefixBlock(input: {
  scopeCapabilities: MemoryScopeCapabilities;
  indices: Record<string, string>;
}): string {
  const sections: string[] = [];
  const { allowed_scopes: allowedScopes, write_scopes: writeScopes, archive_scopes: archiveScopes } = input.scopeCapabilities;
  if (allowedScopes.length || writeScopes.length || archiveScopes.length) {
    sections.push([
      MEMORY_SCOPE_CAPABILITIES_HEADING,
      `- 可读取 scope: ${allowedScopes.length ? allowedScopes.join(", ") : "无"}`,
      `- 可写入 scope: ${writeScopes.length ? writeScopes.join(", ") : "无"}`,
      `- 可归档 scope: ${archiveScopes.length ? archiveScopes.join(", ") : "无"}`,
      "- 执行 memory 工具前，必须先确认目标 scope 在对应权限列表内，避免误操作",
    ].join("\n"));
  }
  const scopeTitles: Record<string, string> = { team: "Team", session: "Session", agent: "Agent", workspace: "Workspace" };
  for (const [scopeName, content] of Object.entries(input.indices)) {
    if (!content) { continue; }
    sections.push(`[${scopeTitles[scopeName] ?? titleCase(scopeName)} ${MEMORY_INDEX_HEADING_SUFFIX}\n${content.trim()}`);
  }
  return sections.join("\n\n");
}

export function memoryBaselineKey(threadKey: string, agentName: string | null): string {
  return `${threadKey.trim() || DEFAULT_THREAD_KEY}::${agentName?.trim() || "_anonymous_"}`;
}

export function readMemoryPrefixSnapshot(
  sessionMetadata: Record<string, unknown>,
  baselineKey: string,
): MemoryPrefixSnapshot | null {
  const states = asRecord(sessionMetadata.memory_prefix_states);
  const snapshot = asRecord(states?.[baselineKey]);
  if (!snapshot) { return null; }
  const fingerprint = asRecord(snapshot.fingerprint);
  const fingerprintValue = getString(fingerprint?.fingerprint);
  const renderedBlock = typeof snapshot.rendered_block === "string" ? snapshot.rendered_block : null;
  if (!fingerprintValue || renderedBlock === null) { return null; }
  return {
    baseline_key: getString(snapshot.baseline_key) ?? baselineKey,
    session_id: getString(snapshot.session_id) ?? "",
    thread_key: getString(snapshot.thread_key) ?? DEFAULT_THREAD_KEY,
    agent_name: getString(snapshot.agent_name) ?? "",
    fingerprint: {
      agent_name: getString(fingerprint?.agent_name),
      auto_inject: fingerprint?.auto_inject !== false,
      allowed_scopes: stringArray(fingerprint?.allowed_scopes),
      write_scopes: stringArray(fingerprint?.write_scopes),
      archive_scopes: stringArray(fingerprint?.archive_scopes),
      scope_specs: readFingerprintScopeSpecs(fingerprint?.scope_specs),
      private_candidate_revision: getString(fingerprint?.private_candidate_revision) ?? "",
      ...(Array.isArray(fingerprint?.scope_revisions)
        ? { scope_revisions: readFingerprintScopeRevisions(fingerprint.scope_revisions) }
        : {}),
      fingerprint: fingerprintValue,
    },
    scope_capabilities: readScopeCapabilities(snapshot.scope_capabilities),
    indices: stringRecord(snapshot.indices),
    rendered_block: renderedBlock,
    rebased_reason: getString(snapshot.rebased_reason) ?? "loaded",
  };
}

function readFingerprintScopeRevisions(value: unknown): NonNullable<MemoryPrefixFingerprint["scope_revisions"]> {
  if (!Array.isArray(value)) { return []; }
  return value
    .map((item) => {
      const record = asRecord(item);
      const revision = getString(record?.revision);
      const [scope] = readFingerprintScopeSpecs(record ? [{ scope_name: record.scope_name, scope_spec: record.scope_spec }] : []);
      return scope && revision !== null ? { ...scope, revision } : null;
    })
    .filter((item): item is NonNullable<MemoryPrefixFingerprint["scope_revisions"]>[number] => Boolean(item));
}

function readFingerprintScopeSpecs(value: unknown): MemoryPrefixFingerprint["scope_specs"] {
  if (!Array.isArray(value)) { return []; }
  return value
    .map((item) => {
      const record = asRecord(item);
      const scopeName = getString(record?.scope_name);
      const scopeSpec = asRecord(record?.scope_spec);
      if (!scopeName || !scopeSpec || !isMemoryScopeName(scopeSpec.scope)) { return null; }
      const output: MemoryPrefixFingerprint["scope_specs"][number] = { scope_name: scopeName, scope_spec: { scope: scopeSpec.scope } };
      for (const key of ["team_name", "session_id", "agent_name", "workspace_key", "user_id"] as const) {
        const stringValue = getString(scopeSpec[key]);
        if (stringValue) { output.scope_spec[key] = stringValue; }
      }
      return output;
    })
    .filter((item): item is MemoryPrefixFingerprint["scope_specs"][number] => Boolean(item));
}

function readScopeCapabilities(value: unknown): MemoryScopeCapabilities {
  const record = asRecord(value);
  return {
    allowed_scopes: stringArray(record?.allowed_scopes),
    write_scopes: stringArray(record?.write_scopes),
    archive_scopes: stringArray(record?.archive_scopes),
  };
}
