import type { RuntimeContainer } from "../../contracts/runtime/runtime-container.js";
import type { TenantRuntimeLease, TenantRuntimeRegistry } from "./tenant-runtime-registry.js";

/** Deployment-neutral registry surface consumed by routes and application composition. */
export type RuntimeContainerRegistry = TenantRuntimeRegistry<RuntimeContainer>;
export type RuntimeContainerLease = TenantRuntimeLease<RuntimeContainer>;
