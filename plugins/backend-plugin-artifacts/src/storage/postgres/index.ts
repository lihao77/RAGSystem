import { ObjectArtifactApplication } from "./object-artifact-application.js";
import { runPostgresArtifactMigrations } from "./artifact-migrations.js";
import { PostgresArtifactMetadataRepository } from "./artifact-repository.js";
import type { ArtifactObjectStorage, ArtifactPostgresExecutor } from "./resources.js";
import type { ArtifactStorageProvider } from "../storage-provider.js";

export interface PostgresArtifactStorageOptions {
  executor: ArtifactPostgresExecutor;
  objects: ArtifactObjectStorage;
}

export function createPostgresArtifactStorage(
  options: PostgresArtifactStorageOptions,
): ArtifactStorageProvider {
  const metadata = new PostgresArtifactMetadataRepository(options.executor);
  return {
    start: async () => {
      await runPostgresArtifactMigrations(options.executor);
    },
    applicationForTenant: (tenantId) => new ObjectArtifactApplication(
      tenantId,
      metadata,
      options.objects,
    ),
  };
}

export { ObjectArtifactApplication, PostgresArtifactMetadataRepository, runPostgresArtifactMigrations };
export type { ArtifactObjectStorage, ArtifactPostgresExecutor } from "./resources.js";
