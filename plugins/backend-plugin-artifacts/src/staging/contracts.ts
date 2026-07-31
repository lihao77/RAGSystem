export const ARTIFACT_STAGING_RESOURCE_KIND = "ragsystem.artifact-staging";

export interface ArtifactStagingRunContext {
  sessionId: string;
  runId: string | null;
  toolCallId: string | null;
}

export interface ArtifactStagingRun {
  stageRunId: string;
  outputDirectory: string;
}

export interface ArtifactStagingOutputInput {
  relativePath: string;
  filename?: string | null;
  mediaType?: string | null;
}

export interface ArtifactStagedFile {
  stagedFileId: string;
  filename: string;
  mediaType: string | null;
  size: number;
  sha256: string;
}

export interface ArtifactStagingService {
  createRun(context: ArtifactStagingRunContext): Promise<ArtifactStagingRun>;
  registerOutputs(
    stageRunId: string,
    outputs: readonly ArtifactStagingOutputInput[],
  ): Promise<readonly ArtifactStagedFile[]>;
  discardRun(stageRunId: string): Promise<void>;
}

export interface ArtifactStagingClaimContext extends ArtifactStagingRunContext {
  tenantId: string;
  stagedFileIds: readonly string[];
}

export interface ArtifactStagingClaim extends ArtifactStagedFile {
  claimId: string;
  sourcePath: string;
}

export interface ArtifactStagingProvider {
  forTenant(tenantId: string, dataRoot: string): ArtifactStagingService;
  claimFiles(context: ArtifactStagingClaimContext): Promise<readonly ArtifactStagingClaim[]>;
  commitClaims(claims: readonly ArtifactStagingClaim[]): Promise<void>;
  rollbackClaims(claims: readonly ArtifactStagingClaim[]): Promise<void>;
  cleanupExpired(): Promise<number>;
}
