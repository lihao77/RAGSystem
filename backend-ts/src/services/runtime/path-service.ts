/**
 * 路径准入服务（backend）—— per-run 持"已批准外部路径"集合。
 *
 * 路径准入融入审批流程：工具 checkAccess 产越界候选（ask，signals.candidatePaths）→
 * gate handler 审批通过 → approve 记录 → 工具 call 读 isApproved 放行。
 * 替代原 SDK ctx.approvedExternalPaths 链——SDK 不再认识路径/审批业务。
 *
 * 已批准路径作为额外"准入 root"：candidate 落在任一已批准路径下即放行（与原 approvedExternalPaths
 * 作 allowedRoots 的语义一致）。受管根（workspace/transient/exports/dataRoot）由各工具自算。
 */
import path from "node:path";

export class PathApprovalService {
  private readonly approved: string[] = [];

  /** 记录审批通过的外部路径（gate handler 审批后调用）。 */
  approve(candidates: Array<string | null | undefined>): void {
    for (const candidate of candidates) {
      if (typeof candidate !== "string") {
        continue;
      }
      const trimmed = candidate.trim();
      if (!trimmed) {
        continue;
      }
      const resolved = path.resolve(trimmed);
      if (!this.approved.includes(resolved)) {
        this.approved.push(resolved);
      }
    }
  }

  /** candidate 落在任一已批准路径下 → true（工具 call 准入 + checkAccess 过滤已批准候选用）。 */
  isApproved(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    return this.approved.some((root) => isPathUnder(resolved, root));
  }

  /**
   * 准入断言：candidate 在受管 roots 内 或 在已批准路径下 → 返回 resolved；否则抛。
   * 各工具的 assertAllowedPath 委托本方法（统一准入 + 已批准放行）。
   */
  assertWithin(candidatePath: string, roots: string[], originalPath: string): string {
    const resolved = path.resolve(candidatePath);
    if (roots.some((root) => isPathUnder(resolved, root)) || this.approved.some((root) => isPathUnder(resolved, root))) {
      return resolved;
    }
    throw new Error(`路径 '${originalPath}' 超出允许的受管目录范围，禁止访问`);
  }

  /** 从候选中筛出仍未批准的外部路径（工具 checkAccess 产候选用）。 */
  collectUnapproved(candidates: Array<string | null | undefined>): string[] {
    const output: string[] = [];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") {
        continue;
      }
      const trimmed = candidate.trim();
      if (trimmed && !this.isApproved(trimmed)) {
        output.push(path.resolve(trimmed));
      }
    }
    return output;
  }
}

function isPathUnder(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
