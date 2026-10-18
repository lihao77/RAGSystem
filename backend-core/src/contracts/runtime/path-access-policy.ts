export interface PathAccessPolicy {
  /** Runtime-provided resource directories; these grants never authorize writes or external cwd. */
  approveRead?(directories: string[]): void;
  isReadApproved?(filePath: string): boolean;
  approve(candidates: Array<string | null | undefined>): void;
  isApproved(filePath: string): boolean;
  assertWithin(candidatePath: string, roots: string[], originalPath: string): string;
  collectUnapproved(candidates: Array<string | null | undefined>): string[];
  setAllowUnapprovedExternalPaths(allow: boolean): void;
}
