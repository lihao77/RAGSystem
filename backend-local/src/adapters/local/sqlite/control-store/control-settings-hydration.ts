import type { ControlPlane } from "@ragsystem/backend-core/contracts/control-plane/index.js";

/** Permanent shape normalization; preserves scene selection and unrelated settings. */
export async function normalizeLocalControlSettings(settings: ControlPlane["settings"]): Promise<void> {
  const current = await settings.getAll();
  const local = {
    deployment_mode: "local", auth_mode: "local", tenancy_mode: "single",
    execution_mode: "local", storage_mode: "sqlite", ui_mode: "local", installed: "true",
  };
  const changed = Object.fromEntries(Object.entries(local).filter(([key, value]) => current[key] !== value));
  if (Object.keys(changed).length) await settings.setMany(changed);
}
