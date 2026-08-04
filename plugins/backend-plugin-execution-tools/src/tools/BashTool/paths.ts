// Backward-compatible export for consumers that imported the historical name.
// New code must use ManagedPathResolver from the shared paths module.
export { ManagedPathResolver, ManagedPathResolver as BashPathResolver } from "../../paths/managed-path-resolver.js";
export type { ManagedRoots, ManagedSpace } from "../../paths/managed-path-resolver.js";
