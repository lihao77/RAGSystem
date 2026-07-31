export { backendPluginModule } from "./module.js";
export { ARTIFACTS_PLUGIN_ID, createArtifactsPlugin } from "./plugin.js";
export { createArtifactToolAfterHook } from "./artifact-hook.js";
export { ArtifactServiceError } from "./artifact-error.js";
export type { ArtifactApplication, ArtifactAssetInput, ArtifactContent, ArtifactRecord } from "./contracts/artifact-application.js";
export type { ArtifactMetadata, ArtifactMetadataRepository, CreateArtifactMetadataInput } from "./contracts/artifact-repository.js";
export type { ArtifactDescriptor, ArtifactIndexEntry, ArtifactSummary } from "./contracts/artifacts.js";
export type { JsonPrimitive, JsonValue } from "./contracts/json.js";
export type { ArtifactSessionAccess, ArtifactsPluginDependencies } from "./dependencies.js";
export type { ArtifactStorageProvider } from "./storage/storage-provider.js";
export { createFilesystemArtifactStorage } from "./storage/filesystem/index.js";
export type { FilesystemArtifactStorageOptions } from "./storage/filesystem/index.js";
export { createPostgresArtifactStorage } from "./storage/postgres/index.js";
export type {
  ArtifactObjectStorage,
  ArtifactPostgresExecutor,
  PostgresArtifactStorageOptions,
} from "./storage/postgres/index.js";
