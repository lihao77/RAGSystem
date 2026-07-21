import type { SystemConfigData } from "./system-config.js";

/** Persistence boundary for tenant system configuration. */
export interface ISystemConfigStore {
  /** Load stored config document, or null when the store has no row/file yet. */
  load(): Promise<SystemConfigData | null>;
  /** Replace the stored config document with the full merged document. */
  save(config: SystemConfigData): Promise<void>;
}
