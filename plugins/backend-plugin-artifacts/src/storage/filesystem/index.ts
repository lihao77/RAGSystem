import { FilesystemArtifactApplication } from "./filesystem-artifact-application.js";
import { FilesystemArtifactService } from "./filesystem-artifact-service.js";
import type { ArtifactStorageProvider } from "../storage-provider.js";

export interface FilesystemArtifactStorageOptions {
  resolveDataRoot(tenantId: string): string;
}

export function createFilesystemArtifactStorage(
  options: FilesystemArtifactStorageOptions,
): ArtifactStorageProvider {
  return {
    applicationForTenant: (tenantId) => new FilesystemArtifactApplication(
      new FilesystemArtifactService({ dataRoot: options.resolveDataRoot(tenantId) }),
    ),
  };
}

export { FilesystemArtifactApplication, FilesystemArtifactService };
