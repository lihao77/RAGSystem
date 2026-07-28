export interface PathAccessPolicy {
  approve(candidates: Array<string | null | undefined>): void;
  isApproved(filePath: string): boolean;
  assertWithin(candidatePath: string, roots: string[], originalPath: string): string;
  collectUnapproved(candidates: Array<string | null | undefined>): string[];
  setAllowUnapprovedExternalPaths(allow: boolean): void;
}
