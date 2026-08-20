export { backendPluginModule } from "./module.js";
export { createPetPlugin, PET_PLUGIN_ID, resolveDefaultPetAssetsRoot, resolveDefaultPetUiRoot } from "./plugin.js";
export type { PetPluginDependencies } from "./plugin.js";
export { PetActivityTracker, mapToolToAnimation } from "./pet-activity.js";
export type { PetActivitySnapshot } from "./pet-activity.js";
export { registerPetAssetRoutes, registerPetUiRoutes } from "./pet-assets.js";
export type { PetAssetRouteOptions, PetUiRouteOptions } from "./pet-assets.js";
export { createPetSystemConfigExtension, resolvePetConfig, DEFAULT_PET_CONFIG } from "./system-config.js";
export type { PetConfig } from "./system-config.js";
