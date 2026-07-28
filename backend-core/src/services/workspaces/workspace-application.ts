import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { WorkspaceApplication } from "../../contracts/workspace/workspace-application.js";
import type { WorkspaceRepositoryPort } from "../../contracts/workspace/workspace-repository.js";
import type { WorkspaceRecord } from "../../contracts/workspace/workspace.js";

export class LocalWorkspaceApplication implements WorkspaceApplication {
  constructor(private readonly repository: WorkspaceRepositoryPort) {}

  async resolveLocalWorkspace(input: Parameters<WorkspaceApplication["resolveLocalWorkspace"]>[0]): Promise<WorkspaceRecord> {
    const rootPath = await normalizeLocalWorkspacePath(input.rootPath);
    const canonicalKey = canonicalLocalWorkspaceKey(rootPath);
    return this.repository.resolveLocal({
      workspaceId: randomUUID(),
      tenantId: input.tenantId,
      kind: "local",
      displayName: path.basename(rootPath) || rootPath,
      rootPath,
      canonicalKey,
    });
  }

  getWorkspace(input: Parameters<WorkspaceApplication["getWorkspace"]>[0]) {
    return this.repository.getById(input.tenantId, input.workspaceId);
  }

  listWorkspacesByIds(input: Parameters<WorkspaceApplication["listWorkspacesByIds"]>[0]) {
    return this.repository.listByIds(input.tenantId, input.workspaceIds);
  }
}

export async function normalizeLocalWorkspacePath(input: string): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Workspace root_path 不能为空");
  if (!path.isAbsolute(trimmed)) throw new Error("Workspace root_path 必须是绝对路径");
  let resolved: string;
  try {
    resolved = await fs.realpath(trimmed);
  } catch {
    throw new Error(`Workspace root_path 必须是已存在的目录: ${trimmed}`);
  }
  if (!(await fs.stat(resolved)).isDirectory()) {
    throw new Error(`Workspace root_path 必须是目录: ${trimmed}`);
  }
  return path.normalize(resolved);
}

export function canonicalLocalWorkspaceKey(rootPath: string): string {
  const normalized = path.normalize(rootPath);
  const withoutTrailing = path.parse(normalized).root === normalized ? normalized : normalized.replace(/[\\/]+$/, "");
  const slashNormalized = withoutTrailing.replaceAll("\\", "/");
  return process.platform === "win32" ? slashNormalized.toLocaleLowerCase("en-US") : slashNormalized;
}
