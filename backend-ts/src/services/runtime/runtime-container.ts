import { createLocalRuntimeContainer } from "../../adapters/local/runtime-container.js";
import type { RuntimeContainer, RuntimeContainerOptions } from "./runtime-container-contracts.js";

export { createCoreRuntimeContainer } from "./core-runtime-container.js";
export { createLocalRuntimeContainer } from "../../adapters/local/runtime-container.js";
export type {
  CoreRuntimeDependencies,
  LocalRuntimeContainerOptions,
  MemoryRuntimeBindingsFactory,
  MemoryRuntimeBindingsFactoryInput,
  RuntimeContainer,
  RuntimeContainerOptions,
} from "./runtime-container-contracts.js";

/**
 * Backwards-compatible local runtime entrypoint.
 * New deployment composition roots should call their explicit factory instead.
 */
export function createRuntimeContainer(options: RuntimeContainerOptions): RuntimeContainer {
  return createLocalRuntimeContainer(options);
}
