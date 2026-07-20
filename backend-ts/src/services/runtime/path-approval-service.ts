import path from "node:path";

import type { PathAccessPolicy } from "../../contracts/runtime/path-access-policy.js";

/** Runtime-scoped path approvals shared by Local and host-tool-restricted deployments. */
export class PathApprovalService implements PathAccessPolicy {
  private readonly approved: string[] = [];
  private allowUnapprovedExternalPaths = false;

  setAllowUnapprovedExternalPaths(allow: boolean): void { this.allowUnapprovedExternalPaths = allow; }

  approve(candidates: Array<string | null | undefined>): void {
    for (const candidate of candidates) {
      if (typeof candidate !== "string" || !candidate.trim()) continue;
      const resolved = path.resolve(candidate.trim());
      if (!this.approved.includes(resolved)) this.approved.push(resolved);
    }
  }

  isApproved(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    return this.approved.some((root) => isPathUnder(resolved, root));
  }

  assertWithin(candidatePath: string, roots: string[], originalPath: string): string {
    const resolved = path.resolve(candidatePath);
    if (
      this.allowUnapprovedExternalPaths
      || roots.some((root) => isPathUnder(resolved, root))
      || this.approved.some((root) => isPathUnder(resolved, root))
    ) {
      return resolved;
    }
    throw new Error(`路径 '${originalPath}' 超出允许的受管目录范围，禁止访问`);
  }

  collectUnapproved(candidates: Array<string | null | undefined>): string[] {
    return candidates
      .filter((candidate): candidate is string => (
        typeof candidate === "string" && candidate.trim() !== "" && !this.isApproved(candidate)
      ))
      .map((candidate) => path.resolve(candidate.trim()));
  }
}

function isPathUnder(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
