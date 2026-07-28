import type { ArtifactApplication } from "../contracts/artifact-application.js";

export interface ArtifactStorageProvider {
  applicationForTenant(tenantId: string): ArtifactApplication | Promise<ArtifactApplication>;
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}
